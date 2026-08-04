# FROZEN CONTRACT 10 — Companion-Plugin REST API (`elementor-ultra/v1/*`)

Status: FROZEN. Owner: API contract owner. Consumers: every TS work package (WP-T##, WP-H##, WP-R##) and the PHP companion plugin (WP-P##).

This is the load-bearing seam between the external TypeScript MCP server (`packages/server`) and the companion WordPress plugin (`plugin/elementor-ultra-mcp`). It is the AUTHORITATIVE definition of every HTTP route the plugin exposes for the FULL product. The MCP tool catalog (contract `40-mcp-catalog.md`, WP-F04) is a thin ergonomic layer over these routes; the TS REST client (`packages/server/src/wp/routes.ts`, WP-T02) is a typed 1:1 wrapper of THIS file.

Companion OpenAPI machine spec: `spec/contracts/openapi.yaml` (same routes; this Markdown is normative where they disagree).

Derivation: RESEARCH.md §3.1 (component diagram), §5 (tool catalog → routes), §7 (safety ops), §8 (auth), §9.2 (controller file layout), SUPPLEMENT.md §A.7 (Pro contracts). Elementor source citations are `path:line` relative to `plugins/elementor` and `plugins/elementor-pro`.

---

## 0. Global conventions (apply to EVERY route)

### 0.1 Base URL, namespace, versioning

- Base: `{WP_URL}/wp-json/elementor-ultra/v1`
- All routes live under namespace `elementor-ultra/v1`. The constant in PHP is `Plugin::REST_NAMESPACE = 'elementor-ultra/v1'`.
- Breaking changes bump the namespace to `elementor-ultra/v2`; this file describes `v1` only. `v1` is frozen — additive fields (new OPTIONAL response keys, new OPTIONAL request fields) are allowed without a version bump; removing/renaming a field or changing a type is a breaking change.

### 0.2 Authentication (RESEARCH.md §8)

- Every route requires `Authorization: Basic base64("<wp_user>:<application_password>")` (WordPress Application Passwords). No nonce, no cookie.
- The TS server forwards the same `Authorization` header to all routes. The plugin's `permission_callback` (`current_user_can(...)`) is the security boundary.
- An unauthenticated request → HTTP 401 `rest_not_logged_in` (WordPress core). A request lacking the route capability → HTTP 403 `E_FORBIDDEN_CAP` (see §0.7 / error taxonomy WP-F05).
- Application Passwords over plain HTTP on local/dev: see WP-S06. The plugin MUST NOT add its own HTTPS enforcement (it would break LocalWP/wp-env).

### 0.3 Capability map (`current_user_can`)

Each route declares ONE of these capability gates. The exact constants live in the error/capability contract (WP-F05) and are mirrored here:

| Gate id | `current_user_can` argument | Notes |
|---|---|---|
| `CAP_READ` | `edit_posts` | discovery/read routes |
| `CAP_EDIT_POST` | `edit_post` (with the target `post_id`) | document mutate routes; falls back to `edit_posts` for create |
| `CAP_MANAGE` | `manage_options` | design-system, cache, kit, ops, capability-sensitive routes |
| `CAP_UPDATE_CLASS` | `Add_Capabilities::UPDATE_CLASS` (`elementor_global_classes_update_class`) | global-class WRITES only. Migration-granted; the plugin idempotently grants it on activation (WP-P01, RESEARCH.md §8, `modules/global-classes/database/add-capabilities.php:14,24`). |
| `CAP_UPLOAD` | `upload_files` | media routes |

The route handler MUST check `unfiltered_html` where relevant and report it via `site/capabilities`, but `unfiltered_html` is NOT a route gate — lacking it degrades fidelity (content is `wp_kses_post`-stripped by core `Document::save()`, `core/base/document.php:841`), it does not 403.

### 0.4 Content types

- Request bodies: `application/json` (except `media/upload` which accepts `multipart/form-data` OR a JSON base64 body — see route).
- Response bodies: `application/json`, UTF-8.

### 0.5 Standard success envelope

EVERY 2xx response uses this envelope (mirrors Elementor's variables REST `{success,data}`, `modules/variables/classes/rest-api.php:418-423`):

```json
{ "success": true, "data": { /* route-specific payload */ } }
```

The per-route "Response" schemas below describe the contents of `data`. The TS client unwraps `data` automatically.

### 0.6 Standard error envelope

EVERY non-2xx response uses the WordPress-REST-native error shape (mirrors `modules/variables/classes/rest-api.php:465-473`), enriched with our taxonomy:

```json
{
  "code": "E_ATOMIC_VALIDATION",
  "message": "Human-readable summary.",
  "data": {
    "status": 422,
    "op_id": "op_7f3a9c2",
    "errors": [
      { "path": "elements[2].settings.title", "code": "E_PROP_INVALID", "message": "...", "meta": {} }
    ],
    "meta": { }
  }
}
```

Rules:
- `code` is a STABLE error code from the error taxonomy (WP-F05). Every code referenced in this file MUST exist there.
- `data.status` is the HTTP status (also the actual response status line).
- `data.errors[]` is present for multi-error / validation responses (e.g. `dry-run`, `save`, `batch`). Each item: `{path, code, message, meta?}`. `path` is a JSON-pointer-like dotted path into the request body (`elements[2].settings.title`).
- `data.op_id` echoes the request `op_id` when one was supplied.
- Handlers MUST NOT string-match Elementor's internal throw messages (e.g. the atomic "Styles validation failed for style ..." at `modules/atomic-widgets/base/has-atomic-base.php:95-98`). They catch the `\Exception`, set `code = E_ATOMIC_VALIDATION`, and pass the raw parser text through as `errors[].message`.

### 0.7 Canonical HTTP-status → taxonomy mapping

| HTTP | When | Representative `code` |
|---|---|---|
| 400 | malformed JSON, missing required field, schema-arg failure | `E_BAD_REQUEST`, `E_MISSING_PARAM` |
| 401 | no/invalid Application Password | `rest_not_logged_in` (core) |
| 403 | authenticated but lacks capability | `E_FORBIDDEN_CAP` |
| 404 | post / class / variable / template not found | `E_NOT_FOUND` |
| 409 | optimistic-lock or autosave conflict, post locked | `E_BASE_HASH_MISMATCH`, `E_AUTOSAVE_CONFLICT`, `E_POST_LOCKED` |
| 422 | semantic validation (atomic prop/style invalid, id collision, budget exceeded, duplicate label) | `E_ATOMIC_VALIDATION`, `E_ID_COLLISION`, `E_BUDGET_EXCEEDED`, `E_DUPLICATED_LABEL`, `E_WOO_CONTEXT_INVALID` |
| 500 | unexpected | `E_INTERNAL` |
| 501 | route present but feature gated off (experiment/Pro inactive) | `E_FEATURE_UNAVAILABLE` |

NOTE: 422 vs 400 — argument-shape failures (wrong type, missing required key) are 400; semantically-valid-but-rejected payloads (a well-formed atomic tree that fails `Props_Parser`) are 422. The TS pre-filter aims to turn would-be-422s into client-side errors, but PHP `dry-run` (§2.3) is AUTHORITATIVE.

### 0.8 Idempotency & locking (RESEARCH.md §7)

- **`op_id`** (string, `^[A-Za-z0-9_.-]{1,64}$`): every WRITE route accepts an OPTIONAL `op_id`. The plugin records it in the op log (`ops/log`) AND embeds it in the document (`editor_settings._emcp_op_id` for document writes). On replay with the SAME `op_id` against the SAME target whose current state already reflects that op, the handler returns the prior result with `data.idempotent_replay: true` and DOES NOT re-apply. `op_id` threads TS → PHP → `Document::save()`.
- **`base_hash`** (string, lowercase md5 hex, 32 chars): optimistic-concurrency token = `md5( get_post_meta($id,'_elementor_data',true) )` returned by every document READ. Document WRITE routes that take `base_hash` MUST compare it against the live value BEFORE writing; mismatch → 409 `E_BASE_HASH_MISMATCH` with `data.meta.current_base_hash`. `base_hash` is REQUIRED on `replace_tree` / `edit` / single-element mutate routes, OPTIONAL on `save` (when omitted, no concurrency check — used for first build).
- **Locking:** before any document write the handler runs `wp_check_post_lock($id)` (core save ignores it) and `get_newer_autosave()` (`core/base/document.php:556-602`). A held edit-lock → 409 `E_POST_LOCKED` (`data.meta.locked_by`); a newer autosave → 409 `E_AUTOSAVE_CONFLICT` (`data.meta.autosave_ts`, `autosave_author`). Both are overridable with request field `force: true`. The plugin NEVER acquires the editor lock on a programmatic save.

### 0.9 dry-run-before-commit RULE (NORMATIVE, RESEARCH.md §1 bullet 5, §6.1, §7)

> The PHP `documents/{id}/dry-run` route (§2.3) is the SINGLE SOURCE OF TRUTH for element-tree validity. Any tool/flow that persists an element tree (`save`, `replace_tree`, `page.build`, `convert.html_to_page`, every Pro `create`, `templates.insert_into_page`) MUST be able to produce, and SHOULD produce, the equivalent `dry-run` result first. `convert.*` (HTML pipeline) MUST NEVER auto-commit — it always runs `dry-run` + returns a diff + coverage report and waits for an explicit `commit:true` call (RESEARCH.md §6.6, §6.8; LOCKED DECISION). The TS validator (`packages/server/src/authoring/prefilter.ts`) is a PRE-FILTER ONLY and is never authoritative.

The plugin implements this internally: `save` / `replace_tree` call the SAME validator (`includes/core/class-validator.php`) that `dry-run` calls, before persisting. A save whose tree fails validation returns 422 and writes NOTHING.

### 0.10 Atomic CSS priming RULE (NORMATIVE, RESEARCH.md §7.4, spike WP-S01)

> V4 atomic CSS does NOT render on a headless `Document::save()` (`modules/atomic-widgets/styles/atomic-styles-manager.php:47-150`). Any route that persists an atomic tree returns `data.css_primed: false` and `data.prime_required: true` unless the caller explicitly requested priming. The caller (TS) MUST then call `documents/{id}/prime-css` (§2.7). `save` and `replace_tree` accept `prime_css: true` to chain the prime in-request.

### 0.11 Pagination contract for ALL list routes (RESEARCH.md §5 "Pagination everywhere")

Every route that returns a collection accepts these query params and returns this envelope. We do NOT reuse the built-in `list-pages` `posts_per_page=-1`.

Request (query string for GET, body for POST-list):
```json
{ "limit": 25, "cursor": "opaque-string|null", "fields": ["id","title"] }
```
- `limit` (int, default 25, max 100). `cursor` (opaque, server-defined; null/omitted = first page). `fields` (optional string[]; when present, only those top-level keys are returned per item — projection).

Response (`data`):
```json
{ "items": [ /* ... */ ], "next_cursor": "opaque-string|null", "total": 137 }
```
- `next_cursor: null` ⇒ last page. `total` is the unfiltered count when cheaply computable, else `null`.

### 0.12 Cache / regen side effects

- Document writes delete `_elementor_css` + `_elementor_element_cache` (core `Document::save()` does this, `core/base/document.php:867,872`). For V3 the handler MAY eager-regen via `Post_CSS::create($id)->update()` when `prime_css:true`. For V4 it MUST use `prime-css` (§2.7).
- ANY design-system write (classes / variables / global colors / fonts / element-defaults / sync) triggers a FULL flush `Plugin::$instance->files_manager->clear_cache()` (`modules/variables/classes/rest-api.php:277-279`, `core/files/manager.php:107-117`). This is done inside the route handler; the caller does not need a separate `cache/regen` call after design writes.

---

## 1. Route index (frozen signatures — quote these verbatim downstream)

Format: `METHOD path` — `cap` — purpose. Detailed schemas follow in §2–§14.

DOCUMENTS (§2)
- `GET  /documents` — CAP_READ — list Elementor documents (paginated)
- `POST /documents` — CAP_EDIT_POST — create blank Elementor document
- `GET  /documents/{id}` — CAP_READ — get element tree + base_hash (depth/subtree/projection modes)
- `GET  /documents/{id}/settings` — CAP_READ — get `_elementor_page_settings`
- `PUT  /documents/{id}/settings` — CAP_EDIT_POST — patch document/page settings (GET-merge-PUT, WP-S04)
- `POST /documents/{id}/dry-run` — CAP_EDIT_POST — AUTHORITATIVE validate + diff, NO persist
- `POST /documents/{id}/save` — CAP_EDIT_POST — `Document::save(['elements','settings'])`
- `POST /documents/{id}/replace-tree` — CAP_EDIT_POST — overwrite whole tree (txn, base_hash)
- `POST /documents/{id}/elements` — CAP_EDIT_POST — granular element op batch (insert/update/move/delete/classes/style/dynamic/global)
- `POST /documents/{id}/prime-css` — CAP_EDIT_POST — prime V4 atomic CSS (WP-S01)
- `POST /documents/{id}/backup` — CAP_EDIT_POST — revision-independent snapshot
- `GET  /documents/{id}/backups` — CAP_READ — list snapshots (paginated)
- `POST /documents/{id}/rollback` — CAP_EDIT_POST — restore snapshot
- `POST /documents/{id}/duplicate` — CAP_EDIT_POST — deep-copy doc+meta
- `DELETE /documents/{id}` — CAP_EDIT_POST — trash document
- `POST /documents/{id}/export` — CAP_READ — emit library-format JSON
- `GET  /documents/{id}/lock-status` — CAP_READ — lock + newer-autosave status

SCHEMA (§3)
- `GET  /schema/widget/{type}` — CAP_READ — per-widget schema (post-filter `get_props_schema()`, incl `_cssid`)
- `GET  /schema/styles` — CAP_READ — atomic `Style_Schema` + units + enums
- `GET  /schema/registered-types` — CAP_READ — registered elTypes/widgetTypes on this site
- `GET  /schema/breakpoints` — CAP_READ — active breakpoints

DESIGN (§4)
- `GET  /design/classes` — CAP_READ — list global classes (paginated) + order
- `PUT  /design/classes` — CAP_UPDATE_CLASS — diff-PUT upsert/delete/reorder (RESEARCH.md §2.2)
- `GET  /design/classes/usage` — CAP_MANAGE — where classes are used
- `GET  /design/variables` — CAP_READ — list variables + watermark
- `POST /design/variables` — CAP_MANAGE — create variable
- `PUT  /design/variables/{id}` — CAP_MANAGE — update variable
- `DELETE /design/variables/{id}` — CAP_MANAGE — delete variable
- `POST /design/variables/{id}/restore` — CAP_MANAGE — restore deleted variable
- `POST /design/variables/batch` — CAP_MANAGE — atomic multi-op (watermark)
- `GET  /design/global-colors` — CAP_READ — V3 kit colors
- `PUT  /design/global-colors` — CAP_MANAGE — set V3 kit colors
- `GET  /design/global-fonts` — CAP_READ — V3 kit typography
- `PUT  /design/global-fonts` — CAP_MANAGE — set V3 kit typography
- `POST /design/fonts/install` — CAP_MANAGE — install a non-catalog @font-face (contract 18 §7-AI S4; font mimes allowed on this path only)
- `GET  /design/element-defaults` — CAP_READ — per-widget kit defaults
- `PUT  /design/element-defaults` — CAP_MANAGE — set per-widget kit defaults
- `POST /design/sync-v4-to-v3` — CAP_MANAGE — flag `sync_to_v3` + regen bridge
- `POST /design/deploy` — CAP_UPDATE_CLASS — bulk deploy classes + variables

MEDIA (§5)
- `GET  /media` — CAP_READ — list/search attachments (paginated)
- `POST /media/sideload` — CAP_UPLOAD — import external URL into library (dedupe)
- `POST /media/upload` — CAP_UPLOAD — upload raw bytes/base64

NAV (§6)
- `GET  /nav/menus` — CAP_READ — list WP nav menus
- `POST /nav/menus` — CAP_MANAGE — create + populate a nav menu
- `POST /nav/bind-widget` — CAP_EDIT_POST — bind Pro nav/mega-menu widget to a menu term

TEMPLATES / KITS (§7)
- `GET  /templates` — CAP_READ — library list (paginated)
- `GET  /templates/{id}` — CAP_READ — template content + settings
- `POST /templates` — CAP_EDIT_POST — save reusable block/page
- `POST /templates/import` — CAP_MANAGE — import .json/.zip (sideload + id remap)
- `POST /templates/{id}/insert` — CAP_EDIT_POST — paste block into a page (id-fresh)
- `POST /kit/export` — CAP_MANAGE — full-site kit zip
- `POST /kit/import` — CAP_MANAGE — upload + import kit
- `POST /kit/revert` — CAP_MANAGE — revert kit import session

PRO (§8)
- `POST /pro/theme` — CAP_EDIT_POST — create theme-builder doc (header/footer/single/archive/404/search/section)
- `PUT  /pro/theme/{id}/conditions` — CAP_EDIT_POST — set display conditions (via `Conditions_Manager::save_conditions`)
- `GET  /pro/theme/conditions-config` — CAP_READ — valid condition keys/sub-conditions per location
- `POST /pro/popup` — CAP_EDIT_POST — create popup doc + display settings + conditions
- `PUT  /pro/popup/{id}/display` — CAP_EDIT_POST — set/merge triggers + timing
- `POST /pro/form/build` — CAP_EDIT_POST — emit a form widget element (classic or atomic)
- `GET  /pro/form/actions` — CAP_READ — registered (license-gated) form actions
- `POST /pro/loop/item` — CAP_EDIT_POST — create loop-item template
- `POST /pro/loop/bind-grid` — CAP_EDIT_POST — configure a loop-grid/carousel widget
- `POST /pro/dynamic/bind` — CAP_EDIT_POST — write `__dynamic__` (V3) / atomic dynamic (V4)
- `GET  /pro/dynamic/tags` — CAP_READ — list dynamic tags
- `GET  /pro/dynamic/tags/{name}` — CAP_READ — per-tag controls/args schema
- `POST /pro/woo/add-widget` — CAP_EDIT_POST — context-validated Woo widget config (ULTRA)

CACHE (§9)
- `POST /cache/regen` — CAP_MANAGE — regenerate CSS (per-post or global)
- `DELETE /cache` — CAP_MANAGE — flush all Elementor CSS (`files_manager->clear_cache`)

IDS (§10)
- `GET  /documents/{id}/ids` — CAP_READ — used-id set for a document
- `POST /ids/remap` — CAP_READ — remap colliding ids in a candidate tree (+ rewrite local-style backrefs)
- `POST /ids/validate` — CAP_READ — validate id uniqueness of a candidate tree

OPS (§11)
- `GET  /ops/log` — CAP_MANAGE — audit trail of writes (paginated)

SITE (§12)
- `GET  /site/capabilities` — CAP_READ — probe experiments/Pro/types/breakpoints/caps/migrations/health

BATCH (§13)
- `POST /batch/plan` — CAP_EDIT_POST — dry-plan a multi-document brief (no persist)
- `POST /batch/apply` — CAP_EDIT_POST — execute a plan with compensation

---

## 2. DOCUMENTS

Controller: `includes/rest/class-documents-controller.php` (WP-P02). Core helpers: `class-document-writer.php`, `class-validator.php`, `class-css-primer.php`, `class-backup-service.php` (RESEARCH.md §9.2).

### 2.1 `GET /documents` — list documents

Cap: CAP_READ. Paginated (§0.11).

Query: `status?` (`any|publish|draft|trash|pending|private`, default `any`), `post_type?` (string or string[], default = all Elementor-built post types), plus `limit/cursor/fields`.

Response `data`:
```json
{
  "items": [
    { "id": 42, "title": "Home", "status": "publish", "url": "https://...", "type": "wp-page", "edit_url": "https://...", "built_with_elementor": true }
  ],
  "next_cursor": null,
  "total": 12
}
```
- `type` = `_elementor_template_type` (`wp-page`, `wp-post`, `header`, `popup`, `loop-item`, ...). Only posts with `_elementor_edit_mode='builder'` are listed.

Errors: 400 `E_BAD_REQUEST` (bad status enum).

### 2.2 `POST /documents` — create blank document

Cap: CAP_EDIT_POST (uses `edit_posts` for create). Wraps `Plugin::$instance->documents->create($type,$post_data,$meta_data)`.

Request:
```json
{
  "title": "New Page",
  "post_type": "page",
  "template_type": "wp-page",
  "status": "draft",
  "op_id": "op_abc"
}
```
- `title` (string, default `"New Page"`). `post_type` (string, default `"page"`). `template_type` (string, default derived from `post_type`; e.g. page→`wp-page`). `status` (enum `draft|publish|pending|private`, default `draft`). `op_id` (optional, §0.8).

Response `data`: `{ "id": 51, "edit_url": "...", "status": "draft", "type": "wp-page" }`.

Errors: 403 `E_FORBIDDEN_CAP`; 400 `E_BAD_REQUEST`.

### 2.3 `POST /documents/{id}/dry-run` — AUTHORITATIVE validate + diff (NO persist)

Cap: CAP_EDIT_POST. This is the SINGLE SOURCE OF TRUTH for validity (§0.9, RESEARCH.md §1 bullet 5). It instantiates every node via `create_element_instance()` + `get_data_for_save()` in try/catch (RESEARCH.md §7), but persists NOTHING.

`{id}` may be `0` to validate a brand-new tree (no existing document).

Request:
```json
{
  "elements": [ /* authoring-contract nodes — see contract 20-authoring-json.md */ ],
  "settings": { /* optional page settings patch */ },
  "generation": "v4",
  "want_preview": false,
  "op_id": "op_xyz"
}
```
- `elements` (array, required) — V4 atomic or V3 classic nodes per the frozen authoring JSON contract (WP-F03, `20-authoring-json.md`). `settings` (object, optional). `generation` (`v4|v3`, optional hint; the validator detects per-node generation regardless). `want_preview` (bool, default false) — when true and validation passes, write a per-user autosave and return a `preview_url` (nonce `post_preview_{id}`); never touches the published tree.

Response `data` (validation PASSED):
```json
{
  "valid": true,
  "errors": [],
  "diff": {
    "changed_ids": ["abc1234"],
    "new_ids": ["hd00001"],
    "removed_ids": [],
    "before": { "abc1234": { /* node */ } },
    "after":  { "abc1234": { /* node */ }, "hd00001": { /* node */ } }
  },
  "preview_url": null,
  "id_collisions": [],
  "generation_detected": "v4"
}
```

Response (validation FAILED) — HTTP 422, error envelope (§0.6):
```json
{
  "code": "E_ATOMIC_VALIDATION",
  "message": "Element-tree validation failed (2 errors).",
  "data": {
    "status": 422,
    "op_id": "op_xyz",
    "errors": [
      { "path": "elements[0].settings.tag", "code": "E_PROP_INVALID", "message": "...", "meta": {"$$type":"string"} },
      { "path": "elements[0].styles.e-abc-7f3a.variants[0].props.display", "code": "E_STYLE_INVALID", "message": "...", "meta": {} }
    ],
    "meta": { "throwing_widget_id": "abc1234" }
  }
}
```
- Atomic save throws (`has-atomic-base.php:88-117`) are caught and surfaced as `errors[]`; the handler NEVER string-matches Elementor messages (§0.6). Unknown legacy elTypes are reported as `E_UNKNOWN_TYPE` warnings inside `errors[]` (they would be silently dropped on a real save).

Errors: 422 `E_ATOMIC_VALIDATION`; 400 `E_BAD_REQUEST` (missing `elements`); 404 `E_NOT_FOUND` (non-zero id absent).

### 2.4 `GET /documents/{id}` — get element tree + base_hash

Cap: CAP_READ. Read modes avoid context blowups (RESEARCH.md §5.11).

Query: `depth?` (int, full depth if omitted), `subtree_id?` (string — return only the subtree rooted at this element id), `projection?` (`full|summary`, default `full`; `summary` returns only `{id,elType,widgetType}` per node).

Response `data`:
```json
{
  "id": 42,
  "elements": [ /* nodes */ ],
  "settings": { /* page settings */ },
  "base_hash": "9f86d081884c7d659a2feaa0c55ad015",
  "generation": "v4",
  "type": "wp-page"
}
```
- `base_hash` = `md5(_elementor_data)` (§0.8). `generation` reflects the dominant node generation.

Errors: 404 `E_NOT_FOUND`.

### 2.5 `GET /documents/{id}/settings` & `PUT /documents/{id}/settings`

GET cap CAP_READ; PUT cap CAP_EDIT_POST.

GET response `data`: `{ "settings": { /* _elementor_page_settings */ } }`.

PUT request:
```json
{ "settings": { "title": "...", "background_background": "classic" }, "base_hash": "...", "op_id": "..." }
```
PUT semantics (WP-S04, RESEARCH.md §5.2 note): the handler does GET-merge-PUT — reads full `_elementor_page_settings`, deep-merges the patch, writes via `Document::save(['settings'=>merged])`. This guarantees partial updates never wipe unrelated keys regardless of `save_settings()` merge-vs-replace behavior. PUT response `data`: `{ "success": true, "settings": { /* merged */ } }`.

Errors: 404 `E_NOT_FOUND`; 409 `E_BASE_HASH_MISMATCH` (if `base_hash` supplied and stale).

### 2.6 `POST /documents/{id}/save` & `POST /documents/{id}/replace-tree`

Cap: CAP_EDIT_POST. Both call the AUTHORITATIVE validator internally BEFORE persisting (§0.9); a failed validation returns 422 and writes NOTHING.

- `save`: persists `elements` and/or `settings`. Used for first build (no `base_hash` required) and idempotent rebuilds (with `op_id`).
- `replace-tree`: overwrites the WHOLE element tree; REQUIRES `base_hash`; intended for surgical full-tree replacement after a read.

Request (`save`):
```json
{
  "elements": [ /* nodes; optional if only settings change */ ],
  "settings": { /* optional */ },
  "base_hash": "...optional for save...",
  "op_id": "op_build_1",
  "prime_css": false,
  "force": false,
  "backup": true
}
```
Request (`replace-tree`): same but `elements` and `base_hash` are REQUIRED.

Behaviour:
1. lock + autosave check (§0.8) unless `force:true`.
2. if `base_hash` present, compare; mismatch → 409.
3. if `backup:true` (default), snapshot to `_emcp_backup_{ts}` meta + `wp_save_post_revision` BEFORE write (RESEARCH.md §7).
4. mint/dedupe ids (§10); run AUTHORITATIVE validator; on failure 422, write nothing.
5. single `Document::save(['elements','settings'])` (`core/base/document.php:795-893`).
6. embed `op_id` in `editor_settings._emcp_op_id`.
7. if `prime_css:true` → run prime-css (§2.7) in-request; else return `css_primed:false`.

Response `data`:
```json
{
  "id": 42,
  "diff": { "changed_ids": [], "new_ids": [], "removed_ids": [], "before": {}, "after": {} },
  "base_hash": "<new md5>",
  "preview_url": "https://.../?preview=true&...",
  "backup_handle": { "meta_key": "_emcp_backup_1700000000", "revision_id": 998 },
  "css_primed": false,
  "prime_required": true,
  "remapped_ids": { "old": "new" },
  "idempotent_replay": false,
  "op_id": "op_build_1"
}
```

Errors: 422 `E_ATOMIC_VALIDATION` / `E_ID_COLLISION`; 409 `E_BASE_HASH_MISMATCH` / `E_POST_LOCKED` / `E_AUTOSAVE_CONFLICT`; 404 `E_NOT_FOUND`; 403 `E_FORBIDDEN_CAP`.

### 2.7 `POST /documents/{id}/prime-css` — prime V4 atomic CSS (WP-S01)

Cap: CAP_EDIT_POST. Implements RESEARCH.md §7.4 / §0.10. SPIKE-GATED on WP-S01 (which approach works).

Request: `{ "approach": "loopback", "breakpoints": ["desktop","tablet","mobile"], "op_id": "..." }`
- `approach` (`loopback|programmatic|auto`, default `auto`). `loopback` = server-side `wp_remote_get(get_wp_preview_url($id))` to fire `elementor/frontend/after_enqueue_post_styles` + `elementor/atomic-widgets/styles/register`. `programmatic` = dispatch `elementor/post/render` then the enqueue flow. `auto` = use whichever WP-S01 determined reliable. `breakpoints` (optional) — restrict priming to specific breakpoint files.

Response `data`:
```json
{ "id": 42, "css_primed": true, "approach_used": "loopback", "css_files": ["post-42.css"], "css_bytes": 4096, "warnings": [] }
```
- `css_primed:false` with `warnings[]` if priming could not be confirmed (residual "unstyled until first real hit" per RESEARCH.md §7.4). This is NOT an error response — it is a 200 with a warning.

Errors: 404 `E_NOT_FOUND`; 500 `E_INTERNAL`.

### 2.8 `POST /documents/{id}/backup` & `GET /documents/{id}/backups` & `POST /documents/{id}/rollback`

Revision-independent (RESEARCH.md §7). Cap: backup/rollback CAP_EDIT_POST, list CAP_READ.

`backup` request: `{ "label": "pre-edit", "op_id": "..." }`. Response `data`: `{ "backup_handle": { "meta_key": "_emcp_backup_1700000000", "revision_id": 998, "ts": 1700000000, "label": "pre-edit" } }`.

`GET /backups` response `data` (paginated): `{ "items": [ { "meta_key":"_emcp_backup_1700000000","ts":1700000000,"label":"pre-edit","base_hash":"..." } ], "next_cursor": null, "total": 3 }`.

`rollback` request: `{ "meta_key": "_emcp_backup_1700000000", "prime_css": true, "op_id": "..." }`. Restores snapshot → `_elementor_data` + `_elementor_page_settings`, deletes CSS/cache, regenerates (V3 `Post_CSS::create($id)->update()`; V4 prime). Response `data`: `{ "id": 42, "restored_from": "_emcp_backup_1700000000", "base_hash": "<new>", "css_primed": true }`.

Errors: 404 `E_NOT_FOUND` (post or snapshot missing).

### 2.9 `POST /documents/{id}/duplicate`, `DELETE /documents/{id}`, `POST /documents/{id}/export`

- `duplicate` (CAP_EDIT_POST): request `{ "title": "...optional...", "status": "draft", "op_id": "..." }`; deep-copies `_elementor_data` + all `_elementor_*` meta into a new post with FRESH ids (mirror export id replacement, `core/base/document.php:1641-1654`). Response `data`: `{ "id": 77, "edit_url": "..." }`.
- `DELETE` (CAP_EDIT_POST): query `force?` (bool, default false = trash; true = permanently delete). Response `data`: `{ "id": 42, "deleted": true, "trashed": true }`.
- `export` (CAP_READ): request `{}`. Response `data`: `{ "content": [...], "page_settings": {...}, "type": "wp-page", "version": "4.1.1", "global_classes": {...}, "global_variables": {...} }` (library-format JSON; includes referenced global classes/variables so the block is portable).

### 2.10 `GET /documents/{id}/lock-status`

Cap: CAP_READ. Response `data`:
```json
{ "id": 42, "locked": false, "locked_by": null, "newer_autosave": false, "autosave_ts": null, "autosave_author": null, "base_hash": "..." }
```
Wraps `wp_check_post_lock` + `get_newer_autosave` (`core/base/document.php:556-602`).

---

## 3. SCHEMA

Controller: `includes/rest/class-schema-controller.php` (WP-P03). All CAP_READ, all read-only/cacheable.

### 3.1 `GET /schema/widget/{type}`

`{type}` = a widgetType (`e-heading`, `heading`, `form`, ...) or container elType (`e-div-block`). Returns the POST-FILTER schema (RESEARCH.md §2.1: `get_props_schema()`, incl auto-injected `_cssid` and any `elementor/atomic-widgets/props-schema`-filter-added props, e.g. Pro `display-conditions`). For classic widgets returns `get_controls()`.

Response `data`:
```json
{
  "type": "e-heading",
  "generation": "v4",
  "is_container": false,
  "props_schema": { /* prop_name -> { kind, key, default, settings:{enum?,units?,required?}, dynamic?:{active,categories} } */ },
  "dynamic_props": ["title"],
  "version": "0.0"
}
```
For classic: `{ "type":"heading","generation":"v3","controls":{ /* control_name -> control config */ } }`.

Errors: 404 `E_NOT_FOUND` (type not registered on this site).

### 3.2 `GET /schema/styles`

Returns the flat `Style_Schema::get_style_schema()` map (post `elementor/atomic-widgets/styles/schema` filter, runtime-extended background sub-schema) + unit presets (`Size_Constants`) + enum value lists (SUPPLEMENT.md §B.3).

Response `data`:
```json
{
  "props": { "display": { "kind":"plain","key":"string","enum":["block","flex",...] }, "padding": { "kind":"union","members":["dimensions","size"] } },
  "units": { "standard": ["px","em","rem","vw","vh","ch","%","auto","custom"], "typography": ["px","em","rem","vw","vh","ch","%","custom"], "...": [] },
  "states": ["hover","active","focus","focus-visible","checked","e--selected"]
}
```

### 3.3 `GET /schema/registered-types`

Used by validation (RESEARCH.md §4.5 rule 2). Response `data`:
```json
{
  "elements": ["e-div-block","e-flexbox","container","section","column",...],
  "widgets": ["e-heading","e-button","heading","form","loop-grid",...],
  "atomic_available": true,
  "pro_active": true
}
```

### 3.4 `GET /schema/breakpoints`

(RESEARCH.md §6.7, SUPPLEMENT.md §C.3). Response `data`:
```json
{
  "items": [ { "key":"mobile","label":"Mobile","direction":"max","value":767 }, { "key":"tablet","label":"Tablet","direction":"max","value":1024 }, { "key":"widescreen","label":"Widescreen","direction":"min","value":2400 } ],
  "active_direction": "max",
  "desktop_first": true
}
```
Keys from `core/breakpoints/manager.php:17-23`. `direction` ∈ `min|max`. NEVER hardcode 768/1024 — read this route.

---

## 4. DESIGN SYSTEM

Controller: `includes/rest/class-design-controller.php` (WP-P05). Backed by `Global_Classes_Repository` (NOT raw meta) and `Variables_Service` (RESEARCH.md §2.2). EVERY write triggers a full `files_manager->clear_cache()` (§0.12).

### 4.1 `GET /design/classes` — list global classes

Cap: CAP_READ. Query: `context?` (`frontend|preview`, default `frontend`), plus `limit/cursor`.

Response `data`:
```json
{
  "items": [ { "id":"g-3f9ab2","label":"card","type":"class","variants":[ /* ... */ ] } ],
  "order": ["g-3f9ab2","g-newid"],
  "next_cursor": null,
  "total": 14
}
```
- `order` is the FULL current order array (needed to build a valid diff-PUT). The TS caller MUST GET first to learn current ids + order before any PUT.

### 4.2 `PUT /design/classes` — diff-PUT upsert/delete/reorder (NORMATIVE)

Cap: CAP_UPDATE_CLASS (`elementor_global_classes_update_class`; 403 `E_FORBIDDEN_CAP` if absent — see WP-P01 activation grant). This is the DIFF-BASED contract (RESEARCH.md §2.2, `modules/global-classes/global-classes-rest-api.php:150-224,306-390`). The companion route proxies to `elementor/v1/global-classes` PUT with identical body semantics (it may call the repository `apply_changes()` directly).

Request (EXACT shape — do not reshape downstream):
```json
{
  "context": "frontend",
  "changes": {
    "added":    ["g-newid"],
    "deleted":  ["g-oldid"],
    "modified": ["g-existingid"],
    "order":    true
  },
  "items": {
    "g-newid":      { "id":"g-newid","type":"class","label":"hero","variants":[ /* ... */ ] },
    "g-existingid": { "id":"g-existingid","type":"class","label":"card","variants":[ /* ... */ ] }
  },
  "order": ["g-existingid","g-newid"],
  "op_id": "op_classes_1"
}
```
NORMATIVE rules (enforced by Elementor; the TS client MUST satisfy them):
- `items` contains ONLY touched ids (added + modified) — never the full collection.
- `order` (top-level) is the FULL final id list and MUST be consistent with `final_item_ids` (= existing − deleted + added) or the handler returns 422 `E_INVALID_ORDER` (`...:366-372`).
- Deletion is EXPLICIT via `changes.deleted` — omitting an id does NOT delete it (`...:357`).
- Budget: `count(existing) − count(deleted) + count(added) ≤ 1000`, else 422 `E_BUDGET_EXCEEDED` with `data.meta.{current_count,max_allowed}` (`...:331-341`). The route pre-flights this before calling Elementor.
- On duplicate labels, Elementor auto-renames; the response carries them as a SOFT error the agent reconciles.

Response `data`:
```json
{ "ok": true, "modified_labels": { "g-newid": { "modified": "hero-2" } }, "order": ["g-existingid","g-newid"], "total": 2 }
```
- `modified_labels` present (and non-empty) ⇒ DUPLICATED_LABEL soft outcome (`...:382-387`); the caller MUST rebind elements expecting the original label to the renamed id. This is a 200, not an error.

Errors: 403 `E_FORBIDDEN_CAP`; 422 `E_BUDGET_EXCEEDED` / `E_INVALID_ORDER` / `E_STYLE_INVALID`.

### 4.3 `GET /design/classes/usage`

Cap: CAP_MANAGE. Query: `context?`. Response `data`: `{ "usage": { "g-3f9ab2": { "total": 4, "pages": [ { "post_id":42,"count":2 } ] } } }`. (`...:135`.)

### 4.4 Variables (RESEARCH.md §2.2, `modules/variables/classes/rest-api.php`)

All three types are FREE: `global-color-variable`, `global-font-variable`, `global-size-variable`. The companion proxies the Elementor variables service; `watermark` is the optimistic-concurrency token. Limits: id ≤ 64 chars, label ≤ 50 chars, value ≤ 512 chars, ≤ 1000 variables (`rest-api.php:31-33`).

`GET /design/variables` — CAP_READ. Response `data`: `{ "variables": { "e-gv-1": { "type":"global-color-variable","label":"brand","value":"#375EFB","order":0 } }, "total": 1, "watermark": 7 }`.

`POST /design/variables` — CAP_MANAGE. Request: `{ "type":"global-color-variable","label":"brand","value":"#375EFB","op_id":"..." }`. Response `data`: `{ "variable": { /* ... */ }, "watermark": 8 }`. Errors: 422 `E_BUDGET_EXCEEDED` (limit reached), 422 `E_DUPLICATED_LABEL`, 422 `E_TYPE_MISMATCH`.

`PUT /design/variables/{id}` — CAP_MANAGE. Request: `{ "label":"brand","value":"#0a0a0a","order":2,"type":"...optional...","op_id":"..." }` (label+value REQUIRED, mirroring `rest-api.php:82-117`). Response `data`: `{ "variable": {...}, "watermark": 9 }`. Errors: 404 `E_NOT_FOUND`, 422 `E_DUPLICATED_LABEL`/`E_TYPE_MISMATCH`.

`DELETE /design/variables/{id}` — CAP_MANAGE. Response `data`: `{ "variable": {...}, "watermark": 10 }`. (Soft-delete; restorable.)

`POST /design/variables/{id}/restore` — CAP_MANAGE. Request: `{ "label?":"...","value?":"...","type?":"..." }` (overrides optional). Response `data`: `{ "variable": {...}, "watermark": 11 }`.

`POST /design/variables/batch` — CAP_MANAGE. Atomic multi-op. Request:
```json
{ "watermark": 11, "operations": [ { "type":"create","payload":{...} }, { "type":"update","id":"e-gv-1","payload":{...} }, { "type":"delete","id":"e-gv-2" }, { "type":"reorder","order":["e-gv-1"] } ], "op_id":"..." }
```
- `operation.type` ∈ `create|update|delete|restore|reorder` (`rest-api.php:507`). `watermark` REQUIRED; a stale watermark fails the batch.
- Response `data`: `{ "variables": {...}, "watermark": 12, "total": 1 }`.
- Batch error (422): `{ "success":false, "code":"E_BATCH_FAILED", "message":"...", "data": { "<id>": { "status":422, "message":"..." } } }` (mirrors `rest-api.php:544-616`; map Elementor's `batch_duplicated_label`/`batch_variables_limit_reached`/`batch_variables_not_found` to taxonomy codes in WP-F05).

### 4.5 V3 global colors / fonts

`GET/PUT /design/global-colors` and `GET/PUT /design/global-fonts` — read CAP_READ, write CAP_MANAGE. Operate on kit settings repeaters `system_colors`/`custom_colors` and `system_typography`/`custom_typography` (RESEARCH.md §2.2) via `Document::save_settings()` on the active kit.

PUT colors request:
```json
{ "system_colors": [ { "_id":"primary","title":"Primary","color":"#375EFB" } ], "custom_colors": [ { "_id":"c1","title":"Brand","color":"#0a0a0a" } ], "op_id":"..." }
```
Response `data`: `{ "system_colors":[...], "custom_colors":[...] }`. Triggers full kit cache flush (`kit.php:105`).

PUT fonts request mirrors with `system_typography`/`custom_typography` (each item `{_id,title,typography_typography:"custom",typography_font_family,...}`).

### 4.6 `GET/PUT /design/element-defaults`

Read CAP_READ, write CAP_MANAGE. Per-widget kit defaults. PUT request: `{ "type":"heading","settings":{...},"op_id":"..." }`. Response `data`: `{ "defaults": { "heading": {...} } }`.

### 4.7 `POST /design/sync-v4-to-v3`

Cap: CAP_MANAGE. Flags a V4 variable `sync_to_v3` and regenerates the bridge stylesheet (RESEARCH.md §2.2 design-system-sync). Request: `{ "variable_id":"e-gv-1","op_id":"..." }`. Response `data`: `{ "success": true, "bridge_var": "--e-global-color-v4-brand" }`.

### 4.8 `POST /design/deploy` — bulk deploy

Cap: CAP_UPDATE_CLASS (because it writes classes). One-shot apply of classes + variables (RESEARCH.md §5.4). Request:
```json
{ "global_classes": { "added":[...],"modified":[...],"deleted":[...],"items":{...},"order":[...] }, "global_variables": { "operations":[...], "watermark": 11 }, "op_id":"..." }
```
- `global_classes` follows the diff-PUT shape (§4.2); `global_variables` follows the batch shape (§4.4). Pre-flights BOTH 1000-item budgets before applying either; if either would exceed, returns 422 `E_BUDGET_EXCEEDED` and applies NEITHER (all-or-nothing). Response `data`: `{ "classes": { "ok":true,"modified_labels":{} }, "variables": { "watermark": 12 } }`.

---

## 5. MEDIA

Controller: `includes/rest/class-media-controller.php` (WP-P06). RESEARCH.md §5.5.

### 5.1 `GET /media` — list/search attachments

Cap: CAP_READ. Query: `query?` (search string), `mime?` (e.g. `image/png`), plus `limit/cursor`. Response `data`: `{ "items":[ { "attachment_id":123,"url":"...","title":"...","alt":"...","mime":"image/jpeg","sizes":{...} } ], "next_cursor":null, "total":48 }`.

### 5.2 `POST /media/sideload` — import external URL into library

Cap: CAP_UPLOAD. Wraps `media_handle_sideload`. Dedupes by a source-hash meta (`_elementor_source_image_hash`, RESEARCH.md §5.5). Request: `{ "url":"https://example.com/x.jpg","alt":"...","title":"...","op_id":"..." }`. Response `data`: `{ "attachment_id":124,"url":"...","sizes":{ "full":{...},"large":{...} },"deduped":false }`.

Errors: 400 `E_BAD_REQUEST` (bad/unreachable url), 422 `E_MEDIA_TYPE` (disallowed mime).

NORMATIVE for HTML pipeline (WP-H##): `convert.*` MUST sideload every `<img>`/`background-image` FIRST and emit `image-src` ID-ONLY for internal media (RESEARCH.md §4.1 corrected; `image-src` is id-XOR-url).

### 5.3 `POST /media/upload` — upload raw bytes/base64

Cap: CAP_UPLOAD. Accepts EITHER `multipart/form-data` (file part `file`) OR JSON `{ "data":"<base64>","filename":"x.png","alt":"...","op_id":"..." }`. Response `data`: `{ "attachment_id":125,"url":"...","sizes":{...} }`. Errors: 400 `E_BAD_REQUEST`, 422 `E_MEDIA_TYPE`.

---

## 6. NAV / MENUS

Controller: `includes/rest/class-nav-controller.php` (WP-P07). RESEARCH.md §5.6.

- `GET /nav/menus` — CAP_READ — `{ "items":[ { "term_id":3,"name":"Main","slug":"main","count":5 } ] }` (wraps `wp_get_nav_menus`).
- `POST /nav/menus` — CAP_MANAGE — request `{ "name":"Main","items":[ { "title":"Home","url":"/","parent":0,"object_id":0,"type":"custom" } ],"op_id":"..." }`; wraps `wp_create_nav_menu` + `wp_update_nav_menu_item`; response `data`: `{ "term_id":3,"item_ids":[10,11] }`.
- `POST /nav/bind-widget` — CAP_EDIT_POST — bind a Pro nav-menu/mega-menu widget to a menu term. Request `{ "post_id":42,"element_id":"abc1234","term_id":3,"base_hash":"...","op_id":"..." }`; sets `settings.menu` → derived `menu_id` (`elementor-pro .../nav-menu.php:69,1464-1485`); response `data`: `{ "success":true,"base_hash":"<new>" }`. Errors: 404 `E_NOT_FOUND` (post/element/term).

---

## 7. TEMPLATES / KITS

Controller: `includes/rest/class-templates-controller.php` (WP-P08). RESEARCH.md §5.7. Atomic-V4 template correctness is SPIKE-GATED on WP-S02.

- `GET /templates` — CAP_READ — paginated. Query: `type?` (`page|section|container|header|...`), `limit/cursor`. Response `data`: `{ "items":[ { "template_id":900,"title":"Hero","type":"section" } ], "next_cursor":null, "total":7 }`.
- `GET /templates/{id}` — CAP_READ — `{ "template_id":900,"title":"Hero","type":"section","content":[...],"page_settings":{...} }`.
- `POST /templates` — CAP_EDIT_POST — save a reusable block/page. Request `{ "title":"Hero","type":"section","content":[ /* nodes */ ],"page_settings":{},"op_id":"..." }`. Goes through `Source_Local::save_item` (regenerates ids). Validates content via the AUTHORITATIVE validator first (§0.9). Response `data`: `{ "template_id":901,"type":"section" }`. Errors: 422 `E_ATOMIC_VALIDATION`.
- `POST /templates/import` — CAP_MANAGE — import .json/.zip. Request `{ "file_path":"...","content":{...},"import_mode":"match_site","op_id":"..." }` (one of `file_path`/`content`). Sideloads images + remaps ids + merges global classes/variables (id-remap/merge semantics SPIKE WP-S02). Response `data`: `{ "imported_ids":[902],"warnings":[] }`.
- `POST /templates/{id}/insert` — CAP_EDIT_POST — paste a block into a page with FRESH ids. Request `{ "post_id":42,"parent_id":"abc1234","index":0,"base_hash":"...","op_id":"..." }` OR `{ "post_id":42,"content":[...],"parent_id":...,"index":... }`. Replaces ALL ids on insert (RESEARCH.md §4.6). Runs validator + save. Response `data`: `{ "success":true,"inserted_ids":["xy12345"],"base_hash":"<new>","css_primed":false }`. Errors: 422, 409.
- `POST /kit/export` — CAP_MANAGE — `{ "include":["content","templates","settings","global-classes","variables"],"kitInfo":{...},"customization":{...} }` → `{ "download_url":"...","session":"..." }`.
- `POST /kit/import` — CAP_MANAGE — `{ "session":"...","file_path":"...","include":[...],"customization":{...} }` → `{ "session":"...","imported":{...},"warnings":[] }`.
- `POST /kit/revert` — CAP_MANAGE — `{ "session":"..." }` → `{ "reverted":true }`.

---

## 8. PRO

Controller: `includes/rest/class-pro-controller.php` (WP-P10). All Pro doc creation goes through the document pipeline + Pro APIs (RESEARCH.md §5.8, SUPPLEMENT.md §A.7). EVERY route here first checks Pro is active and the needed experiment; if not → 501 `E_FEATURE_UNAVAILABLE` (`data.meta.{pro_active,experiment}`).

`ConditionTuple` (shared type): `[type, name, sub_name?, sub_id?]` where `type ∈ "include"|"exclude"`. Stored slash-joined via `Conditions_Manager::save_conditions()` (SUPPLEMENT.md §A.1; `elementor-pro .../theme-builder/classes/conditions-manager.php:300-323`) which ALSO calls `cache->regenerate()` — writing meta directly is FORBIDDEN.

### 8.1 `POST /pro/theme` — create theme-builder document

Cap: CAP_EDIT_POST. Request:
```json
{
  "type": "single-post",
  "title": "Blog Post",
  "status": "publish",
  "location": null,
  "elements": [ /* nodes */ ],
  "page_settings": {},
  "conditions": [ ["include","singular","post"], ["exclude","singular","post","55"] ],
  "op_id": "..."
}
```
- `type` ∈ `header|footer|single-post|single-page|archive|search-results|error-404|section` (SUPPLEMENT.md §A.1). `single` (legacy/hidden) is REJECTED → 400 `E_BAD_REQUEST`. `location` REQUIRED only for `type:"section"` (validated against `locations_manager->get_locations()`). `conditions` optional; when present, applied via `save_conditions()`.
- Behaviour: `documents->create(type,...)` → validator → `save(['settings','elements'])` → `save_conditions()`.
- Response `data`: `{ "post_id":120,"edit_url":"...","template_type":"single-post","location":null,"conditions_stored":["include/singular/post","exclude/singular/post/55"] }`.

### 8.2 `PUT /pro/theme/{id}/conditions` — set display conditions

Cap: CAP_EDIT_POST. REPLACES all conditions (`[]` clears). Request: `{ "conditions": [ ["include","general"] ], "check_conflicts": true, "op_id":"..." }`. Calls `save_conditions()` (+ `cache->regenerate()`). Response `data`: `{ "saved":true,"conditions_stored":["include/general"],"conflicts":[ { "template_id":119,"template_title":"Old Header","edit_url":"..." } ] }`. `conflicts` present only when `check_conflicts:true` and single-instance locations (header/footer/single) clash. Popup location is `multiple=true` (no conflict).

### 8.3 `GET /pro/theme/conditions-config`

Cap: CAP_READ. Wraps `Conditions_Manager::get_conditions_config()` (SUPPLEMENT.md §A.1). Response `data`: `{ "tree": { "general": { "label":"Entire site","all_label":"Entire site","sub_conditions":["archive","singular"], "...": {} } }, "id_bearing": ["post","taxonomy","author","child_of"] }`. Use to validate/autocomplete `name`/`sub_name` and learn which sub-conditions take an id — DO NOT hardcode beyond core.

### 8.4 `POST /pro/popup` & `PUT /pro/popup/{id}/display`

`POST /pro/popup` — CAP_EDIT_POST. Request:
```json
{
  "title": "Newsletter",
  "status": "publish",
  "elements": [ /* nodes */ ],
  "layout_settings": { "width":{"unit":"px","size":640}, "overlay":"yes" },
  "display_settings": { "triggers": { "page_load":"yes","page_load_delay":2 }, "timing": { "times":"yes","times_times":3,"times_period":"week" } },
  "conditions": [ ["include","general"] ],
  "op_id": "..."
}
```
- Three storage buckets (SUPPLEMENT.md §A.2): `layout_settings`→`_elementor_page_settings`; `display_settings`→`_elementor_popup_display_settings` via `save_display_settings_data()`; `conditions`→`_elementor_conditions` (location `popup`, REQUIRED for auto-trigger). Group toggles ∈ `"yes"|""`; sub-keys prefixed `{group}_{control}`.
- Response `data`: `{ "post_id":130,"edit_url":"...","display_settings_meta":"_elementor_popup_display_settings","conditions_stored":["include/general"] }`.

`PUT /pro/popup/{id}/display` — CAP_EDIT_POST. MERGES into existing display settings. Request: `{ "triggers":{...},"timing":{...},"op_id":"..." }`. Response `data`: `{ "saved":true,"display_settings":{ "triggers":{...},"timing":{...} } }`.

### 8.5 `POST /pro/form/build` & `GET /pro/form/actions`

`POST /pro/form/build` — CAP_EDIT_POST. Emits a form widget element under a container (classic `form` widget, or atomic `e-form`+`e-form-*` when `e_pro_atomic_form` active). Request (SUPPLEMENT.md §A.3/§A.7):
```json
{
  "post_id": 42,
  "container_id": "abc1234",
  "generation": "v3",
  "form_name": "Contact Us",
  "button_text": "Send",
  "fields": [ { "type":"text","id":"name","label":"Name","required":true,"width":"100" }, { "type":"email","id":"email","label":"Email","required":true } ],
  "actions": [ { "type":"email","email_to":"owner@example.com","email_subject":"...","email_content":"[all-fields]" } ],
  "base_hash": "...",
  "op_id": "..."
}
```
- Maps `type→field_type`; `id→custom_id` (unique, `[A-Za-z0-9_]`); `required→"true"` (the STRING, not bool); `options[]→"label|value\n..."`; assigns a unique repeater `_id` per field; `submit_actions = action types`. Validates each action against `actions_registrar->get()` (license-gated) and field types against the `elementor_pro/forms/field_types` filter.
- Response `data`: `{ "element": { /* widget node */ }, "applied": true, "base_hash":"<new>", "warnings":["action 'mailchimp' not registered (license)"] }`. When `post_id`/`container_id` omitted, returns just `{element}` (no persist) for the TS caller to place.

`GET /pro/form/actions` — CAP_READ. Response `data`: `{ "actions":[ { "name":"email","label":"Email","settings_controls":["email_to","email_subject",...] } ] }` (only registered/licensed actions).

### 8.6 `POST /pro/loop/item` & `POST /pro/loop/bind-grid`

`POST /pro/loop/item` — CAP_EDIT_POST. Creates a post with `_elementor_template_type='loop-item'`. Request: `{ "title":"Card","elements":[...],"op_id":"..." }`. Response `data`: `{ "template_id":140,"edit_url":"..." }`.

`POST /pro/loop/bind-grid` — CAP_EDIT_POST. Configures a `loop-grid`/`loop-carousel` widget (SUPPLEMENT.md §A.4/§A.7). Request:
```json
{
  "post_id": 42, "container_id":"abc1234", "widget":"loop-grid",
  "template_id":"140", "skin":"post", "columns":"3", "posts_per_page":9,
  "query": { "post_type":"portfolio","orderby":"post_date","order":"desc","include_term_ids":["15"],"query_id":"my_loop" },
  "pagination": { "type":"load_more_on_click","load_type":"ajax" },
  "base_hash":"...","op_id":"..."
}
```
- ASSERTS `template_id`'s `_elementor_template_type=='loop-item'` else 422 `E_LOOP_TEMPLATE_INVALID`. Writes query keys with prefix `{skin}_query_`; `posts_per_page`+`columns` are TOP-LEVEL (NOT in the query group). Response `data`: `{ "element":{...},"applied":true,"base_hash":"<new>" }`.

### 8.7 `POST /pro/dynamic/bind`, `GET /pro/dynamic/tags`, `GET /pro/dynamic/tags/{name}`

`POST /pro/dynamic/bind` — CAP_EDIT_POST. Byte-identical to core `Manager::tag_to_text` (SUPPLEMENT.md §A.6). Request: `{ "post_id":42,"element_id":"abc1234","control":"title","tag":"post-title","tag_settings":{},"fallback_value":"Static","base_hash":"...","op_id":"..." }`.
- Builds `[elementor-tag id="<rand7>" name="<tag>" settings="<urlencode(JSON_FORCE_OBJECT)>"]`; writes `settings.__dynamic__[control]` (V3) or the atomic dynamic prop envelope (V4 — shape SPIKE-discovered via `schema/widget`). VALIDATES `control.dynamic.active==true`, tag registered, tag category ∩ control dynamic categories. Empty settings → `settings="%7B%7D"` (NOT empty string).
- Response `data`: `{ "dynamic_string":"[elementor-tag ...]","applied":true,"base_hash":"<new>" }`. Errors: 422 `E_DYNAMIC_INCOMPATIBLE`.

`GET /pro/dynamic/tags` — CAP_READ — `{ "items":[ { "name":"post-title","title":"Post Title","group":"post","categories":["text"] } ] }`.
`GET /pro/dynamic/tags/{name}` — CAP_READ — `{ "name":"post-excerpt","controls":{...},"categories":["text"] }`.

### 8.8 `POST /pro/woo/add-widget` — context-validated (ULTRA, deferred)

Cap: CAP_EDIT_POST. RESEARCH.md §5.8, SUPPLEMENT.md §A.5. Request: `{ "post_id":42,"container_id":"abc1234","widget":"woocommerce-product-title","product_id":null,"settings":{},"base_hash":"...","op_id":"..." }`.
- Classifies the widget by category: `woocommerce-elements-single` → REQUIRES the target doc be a single-product theme-builder template; `woocommerce-elements-archive` → REQUIRES a products-archive/shop template; `woocommerce-elements`/global → no context. A mismatch → 422 `E_WOO_CONTEXT_INVALID` (`data.meta.{widget,required_context,actual_doc_type}`). `wc-add-to-cart` takes an explicit `product_id` and is placeable anywhere.
- Response `data`: `{ "element":{...},"context_ok":true,"context_warning":null,"base_hash":"<new>" }`.

---

## 9. CACHE

Controller: `includes/rest/class-cache-controller.php` (WP-P09). RESEARCH.md §7.2.

- `POST /cache/regen` — CAP_MANAGE. Request: `{ "post_id":42,"network":false,"op_id":"..." }` (omit `post_id` → global regen, batches 100/run). Response `data`: `{ "regenerated":true,"scope":"post","post_id":42 }`. `network:true` mirrors `wp elementor flush-css --network` (reliability SPIKE WP-S07).
- `DELETE /cache` — CAP_MANAGE. Full flush `files_manager->clear_cache()` (`core/files/manager.php:107-117`). Query: `network?`. Response `data`: `{ "flushed":true }`.

---

## 10. IDS

Backed by `includes/core/class-id-service.php` (WP-P04). RESEARCH.md §4.6. All CAP_READ (pure computation, no persist).

- `GET /documents/{id}/ids` — used-id set for a document. Response `data`: `{ "ids":["abc1234","hd00001"],"local_style_ids":["e-abc1234-7f3a9c2"] }`.
- `POST /ids/validate` — request `{ "elements":[...],"against_post_id":42 }`. Response `data`: `{ "valid":false,"collisions":["abc1234"],"duplicate_local_styles":[] }`.
- `POST /ids/remap` — request `{ "elements":[...],"against_post_id":42 }`. Regenerates colliding ids (`substr(strtolower(dechex(wp_rand())),0,7)`, `includes/utils.php:373-375`) AND rewrites local-style backrefs (mirror `styles-ids-modifier.php`). Response `data`: `{ "elements":[...],"remapped":{ "abc1234":"f0e1d2c" } }`.

---

## 11. OPS

Controller: `includes/rest/class-ops-controller.php` (WP-P11). RESEARCH.md §5.10.

- `GET /ops/log` — CAP_MANAGE — paginated. Query: `post_id?`, `user?`, plus `limit/cursor`. Response `data`: `{ "items":[ { "op_id":"op_build_1","post_id":42,"user":"mcp-agent","tool":"documents/save","before_hash":"...","after_hash":"...","result":"ok","ts":1700000000 } ], "next_cursor":null, "total":210 }`.

The plugin writes one op-log row per WRITE route invocation `(op_id, post_id, user, route, before/after base_hash, result, ts)`. The Abilities `create_server()` observability handler (secondary path) is wired to the same store.

---

## 12. SITE

Controller: `includes/rest/class-schema-controller.php` (or a dedicated `class-site-controller.php`) (WP-P03). The single most-called probe (RESEARCH.md §8). MUST be callable before any feature route is assumed to exist (experiment/Pro gating, RESEARCH.md §8 "Experiment gating").

- `GET /site/capabilities` — CAP_READ. Response `data`:
```json
{
  "elementor_version": "4.1.1",
  "pro_version": "4.1.0",
  "pro_active": true,
  "atomic_available": true,
  "v4_default": false,
  "experiments": {
    "e_atomic_elements": "active",
    "e_classes": "active",
    "e_variables": "active",
    "e_opt_in_v4_page": "inactive",
    "e_pro_atomic_form": "inactive",
    "e_wp_abilities_api": "inactive"
  },
  "global_classes": true,
  "variables": true,
  "classes_migrated": true,
  "can_update_class": true,
  "unfiltered_html": true,
  "breakpoints": [ { "key":"mobile","direction":"max","value":767 } ],
  "registered_types": { "elements":[...], "widgets":[...] },
  "multisite": false,
  "is_local": true,
  "app_passwords_available": true,
  "abilities_adapter_present": false,
  "plugin_version": "1.0.0",
  "health": "ok"
}
```
- `experiments` values ∈ `active|inactive|default`. `can_update_class` = `current_user_can(UPDATE_CLASS)` (RESEARCH.md §8 — design routes hard-fail with an actionable message when false). `classes_migrated` reports whether the `migrate-to-posts` migration ran (RESEARCH.md §2.2). Exact experiment slugs from RESEARCH.md §8.

---

## 13. BATCH (cross-document transactions, ULTRA — RESEARCH.md §7)

Controller: `includes/rest/class-documents-controller.php` or a dedicated batch handler (WP-P02). Cap: CAP_EDIT_POST (each step re-checks its own capability).

- `POST /batch/plan` — dry-plan a multi-document brief (pages + header + footer + popups + design system). Request: `{ "steps":[ { "route":"documents/save","body":{...} }, { "route":"pro/theme","body":{...} } ],"op_id":"..." }`. Runs each step's validator (no persist). Response `data`: `{ "plan":[ { "step":0,"route":"documents/save","valid":true,"diff":{...} } ], "backups_required":[ { "post_id":42 }, { "kit":true } ], "valid": true }`.
- `POST /batch/apply` — execute the plan with best-effort compensation. Request: `{ "plan":[...],"op_id":"..." }`. Records backups of the kit + every touched doc UP FRONT; on partial failure rolls back created docs + restores the kit snapshot. Response `data`: `{ "results":[ { "step":0,"ok":true,"post_id":42 }, { "step":1,"ok":false,"error":{"code":"E_ATOMIC_VALIDATION"} } ], "compensated": true }`. A failed step does NOT raise an HTTP error — the per-step `results[]` carries the outcome; the HTTP status is 200 unless the request itself is malformed (400) or compensation failed (500 `E_COMPENSATION_FAILED`).

---

## 14. Element-op batch (granular surgical ops)

`POST /documents/{id}/elements` — CAP_EDIT_POST. Implements all RESEARCH.md §5.3 granular tools as a SINGLE read-mutate-validate-write transaction (one `Document::save()`, never N partial saves — RESEARCH.md §7). REQUIRES `base_hash`.

Request:
```json
{
  "base_hash": "...",
  "ops": [
    { "op":"insert", "parent_id":"abc1234", "index":0, "node":{ /* authoring node */ } },
    { "op":"update_settings", "element_id":"hd00001", "settings":{ /* patch */ } },
    { "op":"move", "element_id":"hd00001", "new_parent_id":"def5678", "index":1 },
    { "op":"delete", "element_id":"xy99999" },
    { "op":"set_classes", "element_id":"abc1234", "class_ids":["g-card","e-abc1234-7f3a"] },
    { "op":"set_local_style", "element_id":"abc1234", "style_id":"e-abc1234-7f3a", "variant":{ "meta":{"breakpoint":"desktop","state":null}, "props":{...} } },
    { "op":"bind_dynamic", "element_id":"hd00001", "control":"title", "tag_name":"post-title", "tag_settings":{} },
    { "op":"bind_global", "element_id":"hd00001", "control":"title_color", "global_ref":"globals/colors?id=primary" }
  ],
  "force": false,
  "prime_css": false,
  "op_id": "op_surgical_1"
}
```
- All ops applied IN ORDER in memory, then deduped, validated (AUTHORITATIVE), then ONE save. Any op failing validation → 422, nothing persisted. `set_local_style` upserts a style in the element's `styles` map AND ensures the id is in the element's `classes` prop (RESEARCH.md §4.1/§4.5 rule 4). `op:"get"` is NOT here — single reads use `GET /documents/{id}?subtree_id=...`.
- Response `data`: `{ "id":42,"diff":{ "changed_ids":["hd00001"],"new_ids":["xy12345"],"removed_ids":["xy99999"] },"base_hash":"<new>","css_primed":false,"remapped_ids":{} }`.

Errors: 409 `E_BASE_HASH_MISMATCH`/`E_POST_LOCKED`/`E_AUTOSAVE_CONFLICT`; 422 `E_ATOMIC_VALIDATION`/`E_ID_COLLISION`; 404 `E_NOT_FOUND` (post or referenced element id).

---

## 15. Contract-summary index (downstream authors quote these VERBATIM)

Route signatures (METHOD path — cap):

```
GET    /documents                              CAP_READ
POST   /documents                              CAP_EDIT_POST
GET    /documents/{id}                         CAP_READ
GET    /documents/{id}/settings                CAP_READ
PUT    /documents/{id}/settings                CAP_EDIT_POST
POST   /documents/{id}/dry-run                 CAP_EDIT_POST   (AUTHORITATIVE validator)
POST   /documents/{id}/save                    CAP_EDIT_POST
POST   /documents/{id}/replace-tree            CAP_EDIT_POST
POST   /documents/{id}/elements                CAP_EDIT_POST   (granular op batch)
POST   /documents/{id}/prime-css               CAP_EDIT_POST   (WP-S01)
POST   /documents/{id}/backup                  CAP_EDIT_POST
GET    /documents/{id}/backups                 CAP_READ
POST   /documents/{id}/rollback                CAP_EDIT_POST
POST   /documents/{id}/duplicate               CAP_EDIT_POST
DELETE /documents/{id}                         CAP_EDIT_POST
POST   /documents/{id}/export                  CAP_READ
GET    /documents/{id}/lock-status             CAP_READ
GET    /documents/{id}/ids                      CAP_READ
GET    /schema/widget/{type}                   CAP_READ
GET    /schema/styles                          CAP_READ
GET    /schema/registered-types                CAP_READ
GET    /schema/breakpoints                      CAP_READ
GET    /design/classes                          CAP_READ
PUT    /design/classes                          CAP_UPDATE_CLASS   (diff-PUT)
GET    /design/classes/usage                    CAP_MANAGE
GET    /design/variables                         CAP_READ
POST   /design/variables                         CAP_MANAGE
PUT    /design/variables/{id}                    CAP_MANAGE
DELETE /design/variables/{id}                    CAP_MANAGE
POST   /design/variables/{id}/restore            CAP_MANAGE
POST   /design/variables/batch                   CAP_MANAGE
GET    /design/global-colors                     CAP_READ
PUT    /design/global-colors                     CAP_MANAGE
GET    /design/global-fonts                      CAP_READ
PUT    /design/global-fonts                      CAP_MANAGE
POST   /design/fonts/install                     CAP_MANAGE
GET    /design/element-defaults                  CAP_READ
PUT    /design/element-defaults                  CAP_MANAGE
POST   /design/sync-v4-to-v3                     CAP_MANAGE
POST   /design/deploy                            CAP_UPDATE_CLASS
GET    /media                                    CAP_READ
POST   /media/sideload                           CAP_UPLOAD
POST   /media/upload                             CAP_UPLOAD
GET    /nav/menus                                CAP_READ
POST   /nav/menus                                CAP_MANAGE
POST   /nav/bind-widget                          CAP_EDIT_POST
GET    /templates                                CAP_READ
GET    /templates/{id}                           CAP_READ
POST   /templates                                CAP_EDIT_POST
POST   /templates/import                         CAP_MANAGE
POST   /templates/{id}/insert                    CAP_EDIT_POST
POST   /kit/export                               CAP_MANAGE
POST   /kit/import                               CAP_MANAGE
POST   /kit/revert                               CAP_MANAGE
POST   /pro/theme                                CAP_EDIT_POST
PUT    /pro/theme/{id}/conditions                CAP_EDIT_POST
GET    /pro/theme/conditions-config              CAP_READ
POST   /pro/popup                                CAP_EDIT_POST
PUT    /pro/popup/{id}/display                    CAP_EDIT_POST
POST   /pro/form/build                            CAP_EDIT_POST
GET    /pro/form/actions                          CAP_READ
POST   /pro/loop/item                             CAP_EDIT_POST
POST   /pro/loop/bind-grid                         CAP_EDIT_POST
POST   /pro/dynamic/bind                           CAP_EDIT_POST
GET    /pro/dynamic/tags                            CAP_READ
GET    /pro/dynamic/tags/{name}                     CAP_READ
POST   /pro/woo/add-widget                          CAP_EDIT_POST
POST   /cache/regen                                 CAP_MANAGE
DELETE /cache                                       CAP_MANAGE
POST   /ids/validate                                CAP_READ
POST   /ids/remap                                   CAP_READ
GET    /ops/log                                     CAP_MANAGE
GET    /site/capabilities                           CAP_READ
POST   /batch/plan                                  CAP_EDIT_POST
POST   /batch/apply                                 CAP_EDIT_POST
```

Cross-cutting invariants every consumer relies on:
- Success envelope `{success,data}`; error envelope `{code,message,data:{status,op_id?,errors[]?,meta?}}`.
- `op_id` on every write; `base_hash` (md5 of `_elementor_data`) for optimistic locking; `force` overrides lock/autosave 409s.
- Pagination `{limit,cursor,fields[]} -> {items,next_cursor,total}` on every list route.
- dry-run-before-commit; PHP `documents/{id}/dry-run` is AUTHORITATIVE; `convert.*` NEVER auto-commits.
- atomic-CSS priming via `documents/{id}/prime-css` is mandatory after any atomic save (`css_primed`/`prime_required` flags).
- design-system writes auto-flush cache; global-classes PUT is diff-based with explicit `changes.deleted` + full `order`.
- Error codes referenced here are owned by the error taxonomy contract (WP-F05): `E_BAD_REQUEST, E_MISSING_PARAM, E_FORBIDDEN_CAP, E_NOT_FOUND, E_BASE_HASH_MISMATCH, E_AUTOSAVE_CONFLICT, E_POST_LOCKED, E_ATOMIC_VALIDATION, E_PROP_INVALID, E_STYLE_INVALID, E_UNKNOWN_TYPE, E_ID_COLLISION, E_BUDGET_EXCEEDED, E_INVALID_ORDER, E_DUPLICATED_LABEL, E_TYPE_MISMATCH, E_BATCH_FAILED, E_MEDIA_TYPE, E_LOOP_TEMPLATE_INVALID, E_DYNAMIC_INCOMPATIBLE, E_WOO_CONTEXT_INVALID, E_FEATURE_UNAVAILABLE, E_COMPENSATION_FAILED, E_INTERNAL`.
```
