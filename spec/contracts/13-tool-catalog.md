# Contract 13 — FROZEN MCP Tool / Resource / Prompt Catalog

Status: FROZEN. This is the authoritative surface contract for the ULTRA Elementor MCP TypeScript server (`packages/server`). Every tool, resource, and prompt the server exposes is enumerated here. Build WPs in the `ts`, `html`, and `pro` layers implement their assigned slice of this catalog and MUST NOT rename a tool, change its `inputSchema` field names, change its `outputSchema` keys, or change its `annotations` without a contract revision. Downstream agents reuse these exact identifiers.

Source of truth: RESEARCH.md §5 (full catalog), §5.11 (large-surface ergonomics), §3.2 (FAT-TS topology), §4 (authoring contract), §6 (HTML pipeline), §7 (safety), §8 (auth); SUPPLEMENT.md §A.7 (Pro tool I/O), §B (atomic prop reference), §C (HTML stack). Companion REST contract: `spec/contracts/10-rest-api.md` (WP-F02). Authoring JSON contract: `spec/contracts/11-authoring-contract.md` (WP-F03). Error taxonomy + capability probe: `spec/contracts/12-error-taxonomy.md` (WP-F05).

NOTE on shared type names (LOCKED — reuse exactly from the sibling contracts): the general element node type is `ElementNode` (= `AtomicNode | ClassicNode`, `spec/contracts/11-authoring-contract.md` §1); the structured diff is `Diff` and the dry-run result is `DryRunResult` with `ValidationError[]` (`11-authoring-contract.md` §1, `schemas/diff.schema.json`); a global-class object is the `StyleDefinition`-shaped object carrying `id`/`label`/`type:"class"`/`variants[]` (REST contract §4; referred to below as `GlobalClassObject`); a style variant is `StyleVariant` (`11-authoring-contract.md` §1); a display-condition tuple is `ConditionTuple` (REST contract §8 / shared). Error codes are SCREAMING_SNAKE_CASE per `spec/contracts/12-error-taxonomy.md` §3 (e.g. `ATOMIC_SETTINGS_INVALID`, `IMAGE_SRC_XOR_VIOLATION`, `BUDGET_EXCEEDED`).

---

## 0. Conventions (apply to EVERY entry)

### 0.1 SDK shape (LOCKED)

- SDK = `@modelcontextprotocol/sdk@^1.29` (NOT 2.x alpha). In 1.x, `inputSchema` and `outputSchema` are **ZodRawShape maps** — a flat object `{ fieldName: z.zodType, ... }`, NOT a `z.object(...)`. RESEARCH.md §3.2.
- Every tool is registered via `server.registerTool(name, { title, description, inputSchema, outputSchema, annotations }, handler)`.
- In this document, `inputSchema` / `outputSchema` are written as a **zod-ready field map description**: each line is `field: <zod type> — <meaning>`. A build agent transcribes these directly into a `ZodRawShape`. Optional fields are marked `?`. Where a field's value object is a node/style/variant from the authoring contract, the type reference is the named TS type from `spec/contracts/11-authoring-contract.md` (e.g. `ElementNode`, `StyleVariant`, `GlobalClassObject`, `ConditionTuple`). In zod these named types are imported as their `z.<Type>` schema (e.g. `ElementNode` ⇒ the `elementNodeSchema` zod object from `packages/shared`).

### 0.2 Tool naming (LOCKED — RESEARCH.md §5.11)

- All tools are dot-namespaced under the root `elementor.`.
- Names MUST match `^[A-Za-z0-9_.-]{1,128}$`.
- Namespace segments are stable: `tools`, `site`, `pages`, `page`, `element`, `widget`, `schema`, `breakpoints`, `dynamic`, `design`, `media`, `nav`, `templates`, `kit`, `pro`, `convert`, `ops`, `batch`.

### 0.3 Annotations (LOCKED — MCP `annotations`)

Each tool declares the three boolean hints. Defaults if unstated: `readOnlyHint:false, idempotentHint:false, destructiveHint:false`.

- `readOnlyHint:true` — the tool performs no writes (all class `R` tools).
- `idempotentHint:true` — repeated identical calls have the same effect (reads; and writes carrying an `op_id` idempotency key, or pure-set operations).
- `destructiveHint:true` — the tool may destroy or overwrite existing content (class `D` tools). Destructive tools are gated behind elicitation confirm (RESEARCH.md §7.5) and require `confirm:true` or an `elicitation/create` boolean response.

### 0.4 Safety class (LOCKED — RESEARCH.md §5 conventions)

`R` = read-only · `M` = mutating-safe (creates/patches, additive or scoped) · `D` = destructive (overwrites/deletes existing content).

### 0.5 Side (LOCKED — RESEARCH.md §5 conventions, §3.2)

- `TS` — logic lives entirely in the TS server (no companion-plugin REST call for the core work).
- `proxied-to-REST` — the TS handler validates input, then calls one or more companion-plugin REST routes under `elementor-ultra/v1/*` (or, for media/nav primitives, core `wp/v2/*`), and shapes the response. The PHP route is the security + validity boundary.
- `BOTH` — orchestration in TS (multi-step, pipeline, diffing) + one or more proxied REST calls; e.g. `page.build`, `convert.*`, `batch.*`.

### 0.6 Pagination (LOCKED — RESEARCH.md §5 intro, §5.11)

Every list/read tool that returns a collection accepts `{ limit?, cursor?, fields? }` and returns `{ items, next_cursor, total }`:
- `limit: z.number().int().min(1).max(200).default(50)`
- `cursor: z.string().optional()` — opaque continuation token returned as `next_cursor`.
- `fields: z.array(z.string()).optional()` — projection allowlist; omitted = default field set.
- Return: `items: z.array(...)`, `next_cursor: z.string().nullable()`, `total: z.number().int()`.
We do NOT reuse the built-in `list-pages` `posts_per_page=-1` behavior (RESEARCH.md §5 intro, bullet "All list/read tools accept...").

### 0.7 Mutating / edit response shape (LOCKED)

- Every mutating tool carries an `outputSchema`.
- Edit tools that change an existing tree return the structured diff `diff: Diff` (the frozen `Diff` type from `spec/contracts/11-authoring-contract.md` §1 / `schemas/diff.schema.json`; shape includes the changed/new/deleted node ids + before/after hashes via `NodeChange[]`). The before/after element bodies are addressable via the diff's changed ids against `page.get_structure`.
- Write tools that touch a document return `base_hash` (the new optimistic-lock token = `md5(_elementor_data)`) and, where a preview is producible, `preview_url`.

### 0.8 Optimistic concurrency + idempotency (LOCKED — RESEARCH.md §7)

- Surgical write tools (`page.replace_tree`, `widget.*`, `element.*`) REQUIRE `base_hash` (read it from `page.get_structure`). PHP rejects on mismatch (`CONCURRENCY_STALE_HASH`, see `spec/contracts/12-error-taxonomy.md` §3.2).
- Insert/build tools accept `op_id: z.string().optional()` (deterministic idempotency key). On replay the PHP layer detects + no-ops (RESEARCH.md §7 "Idempotency"). `force: z.boolean().default(false)` overrides lock / autosave-conflict refusals.

### 0.9 Error semantics (LOCKED — RESEARCH.md §7.5, see `spec/contracts/12-error-taxonomy.md`)

- Input/schema validation failures → JSON-RPC `-32602` (`SCHEMA_INVALID_PARAMS`, handled by the SDK from the zod schema).
- Runtime/business failures (missing atomic prop, invalid widgetType, lock held, autosave conflict, budget exceeded, capability missing, atomic dry_run rejection) → a tool RESULT with `isError:true` + actionable text + structured content carrying the SCREAMING_SNAKE_CASE error code from the taxonomy (e.g. `ATOMIC_SETTINGS_INVALID`, `CONCURRENCY_STALE_HASH`, `BUDGET_EXCEEDED`, `CAPABILITY_MISSING`). NEVER a protocol error when the agent can fix the input.

---

## 1. Tool catalog

Legend per row: ★ = lean default profile (see §5). Class = R/M/D. Side per §0.5.

### 1.1 Discovery / read (RESEARCH.md §5.1)

#### `elementor.tools.search` ★
- title: "Search MCP tools"; description: "Progressive discovery of the full Elementor tool surface; returns matching tool names + schemas so advanced tools can be enabled on demand."
- inputSchema: `query?: z.string()` — free-text match against tool name/title/description · `prefix?: z.string()` — namespace prefix filter (e.g. `elementor.pro.`) · `limit?: z.number().int().default(30)`.
- outputSchema: `tools: z.array(z.object({ name, title, description, enabled: z.boolean(), inputSchema: z.unknown(), annotations: z.unknown() }))` · `total: z.number().int()`.
- annotations: `readOnlyHint:true, idempotentHint:true`.
- Side: TS. Class: R. Pagination: via `limit` only (no cursor; bounded local registry).
- Note: on match, the server `enable()`s the matched advanced tools and emits `sendToolListChanged()` (§5.3).

#### `elementor.site.capabilities` ★
- title: "Probe site capabilities"; description: "Report experiments, Pro presence, registered element types, breakpoints, capabilities, and migration state for the target site."
- inputSchema: `{}` (empty).
- outputSchema: `v4: z.boolean()` · `atomic: z.boolean()` · `global_classes: z.boolean()` · `variables: z.boolean()` · `pro: z.boolean()` · `pro_atomic_form: z.boolean()` · `breakpoints: z.array(z.object({ key, label, direction: z.enum(['min','max']), value: z.number() }))` · `experiments: z.record(z.string(), z.boolean())` (keys include `e_atomic_elements`, `e_classes`, `e_variables`, `e_opt_in_v4_page`, `e_pro_atomic_form`, `e_wp_abilities_api`) · `can_update_class: z.boolean()` · `classes_migrated: z.boolean()` · `registered_types: z.object({ atomic: z.array(z.string()), classic: z.array(z.string()) })` · `versions: z.object({ elementor: z.string(), pro: z.string().nullable(), plugin: z.string() })` · `unfiltered_html: z.boolean()`.
- annotations: `readOnlyHint:true, idempotentHint:true`.
- Side: proxied-to-REST (`GET elementor-ultra/v1/site/capabilities`). Class: R.
- Note: this is the precondition probe for ALL atomic/design-system/Pro work (RESEARCH.md §8). Sources: experiments `atomic-widgets/module.php:193-195`, `global-classes/module.php:21,38-52`; `can_update_class` = `current_user_can(UPDATE_CLASS)` (`add-capabilities.php:14,24`); `classes_migrated` per `database/migrations/migrate-to-posts.php`.

#### `elementor.pages.list` ★
- title: "List Elementor pages"; description: "List documents built with Elementor (paginated)."
- inputSchema: `status?: z.enum(['any','publish','draft','pending','private','trash']).default('any')` · `post_type?: z.string()` · plus §0.6 pagination.
- outputSchema: §0.6 with `items: z.array(z.object({ id: z.number().int(), title, status, url, type }))`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/documents`). Class: R. Pagination: yes.

#### `elementor.page.get_structure` ★
- title: "Get page element tree"; description: "Read the element tree of a document with depth / subtree / projection controls; returns the optimistic-lock base_hash."
- inputSchema: `post_id: z.number().int()` · `depth?: z.number().int().min(0)` · `subtree_id?: z.string()` — read only this subtree · `projection?: z.enum(['full','summary']).default('full')` — `summary` returns `{id,elType,widgetType}` only (RESEARCH.md §5.11).
- outputSchema: `elements: z.array(ElementNode)` · `base_hash: z.string()` · `generation: z.enum(['v4','v3','mixed'])`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/documents/{id}/structure`). Class: R.

#### `elementor.page.get_settings`
- title: "Get page settings"; description: "Read `_elementor_page_settings` for a document."
- inputSchema: `post_id: z.number().int()`.
- outputSchema: `settings: z.record(z.string(), z.unknown())`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/documents/{id}/settings`). Class: R.

#### `elementor.schema.widget` ★
- title: "Get widget schema"; description: "Per-widget props schema for an atomic widget (post-filter `get_props_schema()`, includes `_cssid` + dynamic-capable flags) or classic widget controls."
- inputSchema: `type: z.string()` — widgetType or elType.
- outputSchema: `kind: z.enum(['atomic','classic'])` · `schema: z.record(z.string(), z.unknown())` · `dynamic_props: z.array(z.string())` — props that accept dynamic binding · `version: z.string()`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/schema/widget/{type}`). Class: R.
- Note: MUST return post-filter `get_props_schema()` (`has-atomic-base.php:310-321`), not `define_props_schema()`. SUPPLEMENT.md §B.2.

#### `elementor.schema.styles` ★
- title: "Get atomic Style-Schema"; description: "The flat atomic Style-Schema (css-prop → prop-type), unit presets, and enums."
- inputSchema: `{}`.
- outputSchema: `props: z.record(z.string(), z.unknown())` · `units: z.record(z.string(), z.array(z.string()))` · `states: z.array(z.string())` (`null,hover,active,focus,focus-visible,checked,e--selected`).
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/schema/styles`). Class: R.
- Note: live shape (Pro injects, background overlay runtime-extended). SUPPLEMENT.md §B.3.

#### `elementor.breakpoints.get` ★
- title: "Get active breakpoints"; description: "Active Elementor breakpoints with direction (min/max) and width."
- inputSchema: `{}`.
- outputSchema: `breakpoints: z.array(z.object({ key, label, direction: z.enum(['min','max']), value: z.number().int() }))` · `default_direction: z.enum(['mobile_first','desktop_first'])`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/breakpoints`). Class: R.
- Note: keys `mobile/mobile_extra/tablet/tablet_extra/laptop/widescreen` (`core/breakpoints/manager.php:17-23`); never hardcode 768/1024 (SUPPLEMENT.md §C.3).

#### `elementor.dynamic.list_tags`
- title: "List dynamic tags"; description: "Available dynamic tags on the site, by category."
- inputSchema: `categories?: z.array(z.string())` · plus §0.6 pagination.
- outputSchema: §0.6 with `items: z.array(z.object({ name, label, group, categories: z.array(z.string()) }))`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/dynamic/tags`). Class: R. Pagination: yes.

#### `elementor.dynamic.get_tag_schema`
- title: "Get dynamic tag schema"; description: "Per-tag controls/args and categories for binding."
- inputSchema: `tag_name: z.string()`.
- outputSchema: `controls: z.record(z.string(), z.unknown())` · `categories: z.array(z.string())` · `group: z.string()`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/dynamic/tags/{tag_name}`). Class: R.
- Note: shortcode encoding per SUPPLEMENT.md §A.6 (`elementor-tag` `tag_to_text` `core/dynamic-tags/manager.php:141-142`).

### 1.2 Page CRUD (RESEARCH.md §5.2)

#### `elementor.page.create` ★
- title: "Create blank page"; description: "Create a blank Elementor document."
- inputSchema: `title?: z.string()` · `post_type?: z.string().default('page')` · `template?: z.string().optional()` · `status?: z.enum(['draft','publish','pending','private']).default('draft')`.
- outputSchema: `id: z.number().int()` · `edit_url: z.string()` · `status: z.string()` · `type: z.string()`.
- annotations: (none — non-idempotent create). Side: proxied-to-REST (`POST elementor-ultra/v1/documents`). Class: M.

#### `elementor.page.build` ★
- title: "Build page from tree"; description: "Batch create-and-populate a document from a declarative element tree; validates via PHP dry_run, saves, and primes atomic CSS."
- inputSchema: `title: z.string()` · `post_type?: z.string().default('page')` · `elements: z.array(ElementNode)` · `settings?: z.record(z.string(), z.unknown())` · `generation?: z.enum(['v4','v3']).default('v4')` · `status?: z.enum(['draft','publish','pending','private']).default('draft')` · `op_id?: z.string()` · `prime_css?: z.boolean().default(true)`.
- outputSchema: `id: z.number().int()` · `edit_url: z.string()` · `preview_url: z.string()` · `diff: Diff` · `base_hash: z.string()` · `css_primed: z.boolean()` · `report?: z.object({ warnings: z.array(z.string()) })` · `remapped_ids?: z.record(z.string(), z.string())` (authored id → live id; present only when ids were remapped).
- annotations: `idempotentHint:true` (when `op_id` supplied). Side: BOTH (TS mints+dedupes ids, pre-filters; proxies `POST elementor-ultra/v1/documents` + `POST .../{id}/save` + `POST .../{id}/prime-css`). Class: M.
- Note: V4 default; falls back to V3 when atomic inactive per probe. Depends on prime-css step (RESEARCH.md §7.4, Spike S1).

#### `elementor.page.replace_tree`
- title: "Replace page tree"; description: "Overwrite the entire element tree of a document in one transaction (optimistic-lock guarded)."
- inputSchema: `post_id: z.number().int()` · `elements: z.array(ElementNode)` · `settings?: z.record(z.string(), z.unknown())` · `base_hash: z.string()` · `confirm?: z.boolean().default(false)` · `force?: z.boolean().default(false)` · `prime_css?: z.boolean().default(true)`.
- outputSchema: `diff: Diff` · `preview_url: z.string()` · `base_hash: z.string()` · `css_primed: z.boolean()` · `remapped_ids?: z.record(z.string(), z.string())` (authored id → live id; present only when ids were remapped).
- annotations: `destructiveHint:true`. Side: proxied-to-REST (`POST elementor-ultra/v1/documents/{id}/save`). Class: D. Elicitation confirm required.

#### `elementor.page.update_settings`
- title: "Update page settings"; description: "Patch document / page settings (GET-merge-PUT so partial updates never wipe unrelated keys)."
- inputSchema: `post_id: z.number().int()` · `settings: z.record(z.string(), z.unknown())` · `base_hash?: z.string()`.
- outputSchema: `success: z.boolean()` · `settings: z.record(z.string(), z.unknown())`.
- annotations: `idempotentHint:true`. Side: proxied-to-REST (`PATCH elementor-ultra/v1/documents/{id}/settings`). Class: M.
- Note: merge-vs-replace is Spike S4; until confirmed, PHP does GET-merge-PUT (RESEARCH.md §5.2 note).

#### `elementor.page.dry_run` ★
- title: "Dry-run validate page"; description: "Authoritative validate-and-diff of an element tree with NO persistence (PHP instantiates every node + get_data_for_save)."
- inputSchema: `post_id?: z.number().int()` · `elements: z.array(ElementNode)` · `settings?: z.record(z.string(), z.unknown())` · `generation?: z.enum(['v4','v3']).default('v4')`.
- outputSchema: `valid: z.boolean()` · `errors: z.array(z.object({ element_id: z.string().nullable(), style_id: z.string().nullable(), prop: z.string().nullable(), code: z.string(), message: z.string() }))` · `diff?: Diff` · `preview_url?: z.string()`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`POST elementor-ultra/v1/documents/{id}/dry-run`, or `POST elementor-ultra/v1/dry-run` when no `post_id`). Class: R.
- Note: THE authoritative validator (RESEARCH.md §1 bullet 5). Catches `\Exception` from `parse_atomic_settings`/`parse_atomic_styles`; returns structured errors (do NOT string-match the throw message, RESEARCH.md §2.1).

#### `elementor.page.duplicate`
- title: "Duplicate page"; description: "Deep-copy a document and its meta (ids regenerated)."
- inputSchema: `post_id: z.number().int()` · `title?: z.string()`.
- outputSchema: `post_id: z.number().int()` · `edit_url: z.string()`.
- annotations: (none). Side: proxied-to-REST (`POST elementor-ultra/v1/documents/{id}/duplicate`). Class: M.

#### `elementor.page.delete`
- title: "Delete page"; description: "Trash a document."
- inputSchema: `post_id: z.number().int()` · `confirm?: z.boolean().default(false)` · `force_delete?: z.boolean().default(false)`.
- outputSchema: `success: z.boolean()` · `trashed: z.boolean()`.
- annotations: `destructiveHint:true`. Side: proxied-to-REST (`DELETE elementor-ultra/v1/documents/{id}`). Class: D. Elicitation confirm required.

#### `elementor.page.export_template`
- title: "Export page as template"; description: "Emit a document in library-format JSON (content + page settings + bundled global classes/variables)."
- inputSchema: `post_id: z.number().int()`.
- outputSchema: `content: z.array(ElementNode)` · `page_settings: z.record(z.string(), z.unknown())` · `type: z.string()` · `version: z.string()` · `global_classes?: z.array(GlobalClassObject)` · `global_variables?: z.record(z.string(), z.unknown())`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/documents/{id}/export`). Class: R.

#### `elementor.page.list_backups`
- title: "List page backups"; description: "List the pre-write backup snapshots for a document (paginated); each carries the meta_key + base_hash to roll back to."
- inputSchema: `post_id: z.number().int()` · pagination (`limit?`, `cursor?`, `fields?`).
- outputSchema: `items: z.array(z.object({ meta_key: z.string(), ts: z.number().int(), label: z.string(), base_hash: z.string() }))` · `next_cursor: z.string().nullable()` · `total: z.number().int()`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/documents/{id}/backups`). Class: R.

#### `elementor.page.rollback`
- title: "Roll back page"; description: "Restore a document to a prior backup snapshot (by meta_key or \"latest\"), then re-prime atomic CSS."
- inputSchema: `post_id: z.number().int()` · `backup?: z.string().default('latest')` (snapshot `meta_key` from `list_backups`, or the literal `"latest"`) · `confirm?: z.boolean().default(false)` · `prime_css?: z.boolean().default(true)`.
- outputSchema: `id: z.number().int()` · `restored_from: z.string()` · `base_hash: z.string()` · `css_primed: z.boolean()`.
- annotations: `destructiveHint:true`. Side: proxied-to-REST (`POST elementor-ultra/v1/documents/{id}/rollback`; resolves `"latest"` via `GET .../{id}/backups`). Class: D. Elicitation confirm required.

#### `elementor.page.verify_render` (contract 18 §7-AI S2 — appended)
- title: "Verify page renders"; description: "Probe that a document actually RENDERS (permalink loopback with in-process front-controller dispatch fallback): asserts HTTP 200 + no fatal marker; a fatal returns render_verified:false (RENDER_FAILED, op-logged)."
- inputSchema: `post_id: z.number().int()`.
- outputSchema: `id: z.number().int()` · `render_verified: z.boolean()` · `method: z.enum(['loopback','dispatch'])` · `http_status: z.number().int().nullable()` · `fatal: z.string().nullable()` · `checked_url: z.string().nullable()`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`POST elementor-ultra/v1/documents/{id}/verify-render`). Class: R. A FAILED probe is a SUCCESS result with `render_verified:false` (soft `RENDER_FAILED`); `page.build` runs the same probe by default (`verify_render: z.boolean().default(true)`) and `page.replace_tree` opt-in (`default(false)`), both returning `render_verified` next to `css_primed`.

### 1.3 Widget / element ops (RESEARCH.md §5.3)

All single-element ops are PHP-side read-mutate-validate-write transactions (one `Document::save()`), never partial saves (RESEARCH.md §5.3, §7).

#### `elementor.element.get`
- title: "Get element"; description: "Read a single node from a document tree."
- inputSchema: `post_id: z.number().int()` · `element_id: z.string()`.
- outputSchema: `node: ElementNode` · `base_hash: z.string()`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/documents/{id}/elements/{element_id}`). Class: R.

#### `elementor.widget.insert` ★
- title: "Insert widget"; description: "Insert a node under a parent at an index (transactional, optimistic-lock + idempotency guarded)."
- inputSchema: `post_id: z.number().int()` · `parent_id: z.string()` · `index?: z.number().int()` · `node: ElementNode` · `base_hash: z.string()` · `op_id?: z.string()` · `force?: z.boolean().default(false)`.
- outputSchema: `diff: Diff` · `inserted_id: z.string()` · `base_hash: z.string()`.
- annotations: `idempotentHint:true` (with `op_id`). Side: proxied-to-REST (`POST elementor-ultra/v1/documents/{id}/elements`). Class: M.

#### `elementor.widget.update_settings` ★
- title: "Update widget settings"; description: "Patch a single node's settings (transactional)."
- inputSchema: `post_id: z.number().int()` · `element_id: z.string()` · `settings: z.record(z.string(), z.unknown())` · `base_hash: z.string()` · `force?: z.boolean().default(false)`.
- outputSchema: `diff: Diff` · `base_hash: z.string()`.
- annotations: `idempotentHint:true`. Side: proxied-to-REST (`PATCH elementor-ultra/v1/documents/{id}/elements/{element_id}/settings`). Class: M.

#### `elementor.element.move`
- title: "Move element"; description: "Reorder or reparent a node."
- inputSchema: `post_id: z.number().int()` · `element_id: z.string()` · `new_parent_id: z.string()` · `index: z.number().int()` · `base_hash: z.string()` · `force?: z.boolean().default(false)`.
- outputSchema: `diff: Diff` · `base_hash: z.string()`.
- annotations: (none). Side: proxied-to-REST (`POST elementor-ultra/v1/documents/{id}/elements/{element_id}/move`). Class: M.

#### `elementor.element.delete`
- title: "Delete element"; description: "Remove a node and its subtree."
- inputSchema: `post_id: z.number().int()` · `element_id: z.string()` · `base_hash: z.string()` · `confirm?: z.boolean().default(false)` · `force?: z.boolean().default(false)`.
- outputSchema: `diff: Diff` · `base_hash: z.string()`.
- annotations: `destructiveHint:true`. Side: proxied-to-REST (`DELETE elementor-ultra/v1/documents/{id}/elements/{element_id}`). Class: D. Elicitation confirm required.

#### `elementor.element.set_classes`
- title: "Set element classes"; description: "Set the `classes` prop (global + local class ids) on a node."
- inputSchema: `post_id: z.number().int()` · `element_id: z.string()` · `class_ids: z.array(z.string())` · `base_hash: z.string()`.
- outputSchema: `diff: Diff` · `base_hash: z.string()`.
- annotations: `idempotentHint:true`. Side: proxied-to-REST (`PATCH elementor-ultra/v1/documents/{id}/elements/{element_id}/classes`). Class: M.

#### `elementor.element.set_local_style`
- title: "Upsert local style"; description: "Upsert a local style variant on a node (mirrors the style id into the element's classes prop)."
- inputSchema: `post_id: z.number().int()` · `element_id: z.string()` · `style_id?: z.string()` · `variant: StyleVariant` · `base_hash: z.string()`.
- outputSchema: `diff: Diff` · `style_id: z.string()` · `base_hash: z.string()`.
- annotations: `idempotentHint:true`. Side: proxied-to-REST (`PUT elementor-ultra/v1/documents/{id}/elements/{element_id}/style`). Class: M.
- Note: local style must be in `styles` map keyed by id AND the id present in the element's `classes` prop (RESEARCH.md §4.1, §4.5 rule 4).

#### `elementor.element.bind_dynamic`
- title: "Bind dynamic value"; description: "Bind a dynamic tag to a control (V3 `__dynamic__` or V4 atomic dynamic prop)."
- inputSchema: `post_id: z.number().int()` · `element_id: z.string()` · `control: z.string()` · `tag_name: z.string()` · `tag_settings?: z.record(z.string(), z.unknown())` · `fallback_value?: z.unknown()` · `base_hash: z.string()`.
- outputSchema: `diff: Diff` · `dynamic_string: z.string()` · `base_hash: z.string()`.
- annotations: `idempotentHint:true`. Side: proxied-to-REST (`PUT elementor-ultra/v1/documents/{id}/elements/{element_id}/dynamic`). Class: M.
- Note: V3 encoding `[elementor-tag id=".." name=".." settings="<urlencoded JSON_FORCE_OBJECT>"]` (SUPPLEMENT.md §A.6); V4 atomic dynamic `$$type`/payload is Spike-discovered via `schema.widget`.

#### `elementor.element.bind_global`
- title: "Bind global value"; description: "Bind a V3 global color/typography to a control via `__globals__`."
- inputSchema: `post_id: z.number().int()` · `element_id: z.string()` · `control: z.string()` · `global_ref: z.string()` — e.g. `globals/colors?id=primary` · `base_hash: z.string()`.
- outputSchema: `diff: Diff` · `base_hash: z.string()`.
- annotations: `idempotentHint:true`. Side: proxied-to-REST (`PUT elementor-ultra/v1/documents/{id}/elements/{element_id}/global`). Class: M.

### 1.4 Design-system ops (RESEARCH.md §5.4)

#### `elementor.design.classes.list` ★
- title: "List global classes"; description: "Global classes with variants + order (paginated)."
- inputSchema: `context?: z.enum(['frontend','preview']).default('frontend')` · plus §0.6 pagination.
- outputSchema: §0.6 with `items: z.array(GlobalClassObject)` · `order: z.array(z.string())`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/design/classes`). Class: R. Pagination: yes.

#### `elementor.design.classes.upsert` ★
- title: "Upsert global classes"; description: "Add or modify global classes via a diff-PUT (PHP builds the changes/items/order body; budget + duplicate-label aware)."
- inputSchema: `added?: z.array(GlobalClassObject)` · `modified?: z.array(GlobalClassObject)`.
- outputSchema: `ok: z.boolean()` · `order: z.array(z.string())` · `modifiedLabels?: z.record(z.string(), z.object({ modified: z.string() }))` — soft-error remap (RESEARCH.md §5.4) · `total_count: z.number().int()`.
- annotations: `idempotentHint:true`. Side: proxied-to-REST (`PUT elementor-ultra/v1/design/classes`). Class: M.
- Note: deletion is NOT via omission (use `classes.delete`); PHP builds the diff body `{changes:{added,deleted,modified,order:bool}, items(touched-only), order(full final list)}` and pre-flights the 1000-item budget (RESEARCH.md §2.2, §5.4). Requires `UPDATE_CLASS`.

#### `elementor.design.classes.delete`
- title: "Delete global classes"; description: "Remove global classes by id (explicit deletion)."
- inputSchema: `ids: z.array(z.string())` · `confirm?: z.boolean().default(false)`.
- outputSchema: `success: z.boolean()` · `order: z.array(z.string())`.
- annotations: `destructiveHint:true`. Side: proxied-to-REST (`PUT elementor-ultra/v1/design/classes` with `changes.deleted`). Class: D. Elicitation confirm required.

#### `elementor.design.classes.reorder`
- title: "Reorder global classes"; description: "Set the full ordering of global classes."
- inputSchema: `order: z.array(z.string())` — full final id list.
- outputSchema: `success: z.boolean()`.
- annotations: `idempotentHint:true`. Side: proxied-to-REST (`PUT elementor-ultra/v1/design/classes` with `order`). Class: M.

#### `elementor.design.classes.usage`
- title: "Global class usage"; description: "Where each global class is used."
- inputSchema: `id?: z.string()` · plus §0.6 pagination.
- outputSchema: §0.6 with `items: z.array(z.object({ id, post_id: z.number().int(), element_ids: z.array(z.string()) }))`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/design/classes/usage`). Class: R. Pagination: yes.

#### `elementor.design.variables.list` ★
- title: "List design variables"; description: "Design tokens (color/font/size) + optimistic watermark."
- inputSchema: §0.6 pagination.
- outputSchema: §0.6 with `items: z.array(z.object({ id, type: z.enum(['global-color-variable','global-font-variable','global-size-variable']), label, value, order: z.number().int() }))` · `watermark: z.number().int()`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/design/variables`). Class: R. Pagination: yes.

#### `elementor.design.variables.create`
- title: "Create design variable"; description: "Create a color/font/size token (all three are FREE in 4.1.x)."
- inputSchema: `type: z.enum(['global-color-variable','global-font-variable','global-size-variable'])` · `label: z.string()` · `value: z.string()`.
- outputSchema: `variable: z.object({ id, type, label, value })` · `watermark: z.number().int()`.
- annotations: (none — non-idempotent). Side: proxied-to-REST (`POST elementor-ultra/v1/design/variables`). Class: M.
- Note: size variables are FREE; do not Pro-gate (RESEARCH.md §2.2, `variables/hooks.php:48-51`).

#### `elementor.design.variables.update`
- title: "Update design variable"; description: "Edit a token (watermark-guarded)."
- inputSchema: `id: z.string()` · `label?: z.string()` · `value?: z.string()` · `watermark: z.number().int()`.
- outputSchema: `watermark: z.number().int()`.
- annotations: `idempotentHint:true`. Side: proxied-to-REST (`POST elementor-ultra/v1/design/variables/batch`, a single `update` op). Class: M.
- Note: transports via the batch route because it is the ONLY §4.4 route that carries `watermark` (PHP enforces `WATERMARK_STALE` there), and its `update` payload is a PARTIAL merge — omitted `label`/`value` keep their current values, matching the optional inputSchema. The single-variable `PUT .../design/variables/{id}` (no watermark; label+value required) is NOT used by this tool.

#### `elementor.design.variables.delete`
- title: "Delete design variable"; description: "Soft-delete a token (watermark-guarded)."
- inputSchema: `id: z.string()` · `watermark: z.number().int()` · `confirm?: z.boolean().default(false)`.
- outputSchema: `watermark: z.number().int()`.
- annotations: `destructiveHint:true`. Side: proxied-to-REST (`POST elementor-ultra/v1/design/variables/batch`, a single `delete` op). Class: D. Elicitation confirm required.
- Note: transports via the batch route because the single-variable `DELETE .../design/variables/{id}` has no body and so cannot carry `watermark`; the batch route enforces `WATERMARK_STALE` server-side.

#### `elementor.design.variables.restore`
- title: "Restore design variable"; description: "Restore a soft-deleted token (best-effort watermark pre-check)."
- inputSchema: `id: z.string()` · `watermark: z.number().int()`.
- outputSchema: `watermark: z.number().int()`.
- annotations: `idempotentHint:true`. Side: proxied-to-REST (`POST elementor-ultra/v1/design/variables/{id}/restore`). Class: M.
- Note: the watermark guard here is BEST-EFFORT and NON-ATOMIC — a client-side pre-check (read the live watermark via `GET /design/variables`, return `WATERMARK_STALE` without writing on mismatch); a concurrent write landing between the check and the restore is not detected. Restore CANNOT use the watermark-enforcing batch transport: Elementor 4.1.1's `Batch_Processor::op_restore` passes the whole op (including `type:'restore'`) into `Variable::apply_changes`, tripping the type-change guard, so batch-restore always fails upstream (field-verified).

#### `elementor.design.variables.batch`
- title: "Batch edit variables"; description: "Atomic multi-edit of tokens (single watermark)."
- inputSchema: `watermark: z.number().int()` · `operations: z.array(z.object({ op: z.enum(['create','update','delete','restore']), id: z.string().optional(), type: z.string().optional(), label: z.string().optional(), value: z.string().optional() }))`.
- outputSchema: `watermark: z.number().int()` · `results: z.array(z.object({ op, id, ok: z.boolean(), error: z.string().nullable() }))`.
- annotations: (none). Side: proxied-to-REST (`POST elementor-ultra/v1/design/variables/batch`). Class: M.

#### `elementor.design.globalColors.list` / `.upsert` / `.delete`
- title: "V3 global colors {list|upsert|delete}"; description: "Read/write V3 kit color repeaters (`system_colors`/`custom_colors`)."
- `.list` inputSchema: `{}`; outputSchema: `system: z.array(z.object({ _id, title, color }))` · `custom: z.array(z.object({ _id, title, color }))`. annotations: `readOnlyHint:true, idempotentHint:true`. Class: R.
- `.upsert` inputSchema: `colors: z.array(z.object({ _id: z.string().optional(), title: z.string(), color: z.string() }))` · `bucket?: z.enum(['system','custom']).default('custom')`; outputSchema: `success: z.boolean()` · `colors`. annotations: `idempotentHint:true`. Class: M.
- `.delete` inputSchema: `ids: z.array(z.string())`; outputSchema: `success: z.boolean()`. annotations: `destructiveHint:true`. Class: D.
- Side: proxied-to-REST (`GET/PATCH/DELETE elementor-ultra/v1/design/global-colors`).

#### `elementor.design.globalFonts.list` / `.upsert` / `.delete`
- Same shape as `globalColors`, over `system_typography`/`custom_typography`; item = `z.object({ _id, title, typography: z.record(z.string(), z.unknown()) })`. Side: proxied-to-REST (`.../design/global-fonts`). Classes R/M/D.

#### `elementor.design.fonts.install`
- title: "Install font face"; description: "Install a NON-Google-catalog font face (contract 18 §7-AI S4): store woff2/woff/ttf/otf bytes under uploads, register its @font-face (Pro Custom Fonts CPT when available, else kit custom CSS), and return the resolved family string for atomic font-family props."
- inputSchema: `source: z.string().min(1)` (http(s) URL, `data:` URI, or raw base64 — real format sniffed from magic bytes) · `family: z.string().min(1)` · `weight?: z.union([z.string(), z.number().int()])` · `style?: z.enum(['normal','italic','oblique'])`.
- outputSchema: `family: z.string()` · `weight: z.string()` · `style: z.string()` · `format: z.string()` · `attachment_id: z.number().int()` · `url: z.string()` · `registered_via: z.enum(['pro_custom_fonts','kit_custom_css'])` · `font_face: z.string()` · `warnings: z.array(z.string())`.
- annotations: `idempotentHint:true`. Side: proxied-to-REST (`POST elementor-ultra/v1/design/fonts/install`, CAP_MANAGE; font mimes allowed on this path only). Class: M.

#### `elementor.design.sync_v4_to_v3`
- title: "Sync V4 variable to V3"; description: "Flag a V4 variable `sync_to_v3` and regenerate the bridge stylesheet."
- inputSchema: `variable_id: z.string()`.
- outputSchema: `success: z.boolean()`.
- annotations: `idempotentHint:true`. Side: proxied-to-REST (`POST elementor-ultra/v1/design/sync-v4-to-v3`). Class: M.

#### `elementor.design.element_defaults.get` / `.set`
- title: "Element defaults {get|set}"; description: "Per-widget kit default settings."
- `.get` inputSchema: `type: z.string()`; outputSchema: `settings: z.record(z.string(), z.unknown())`. annotations: `readOnlyHint:true, idempotentHint:true`. Class: R.
- `.set` inputSchema: `type: z.string()` · `settings: z.record(z.string(), z.unknown())`; outputSchema: `success: z.boolean()`. annotations: `idempotentHint:true`. Class: M.
- Side: proxied-to-REST (`GET/PUT elementor-ultra/v1/design/element-defaults/{type}`).

#### `elementor.design.deploy`
- title: "Deploy design system"; description: "Bulk-deploy global classes + variables in one transaction (budget pre-flighted, full cache flush after)."
- inputSchema: `globalClasses?: z.array(GlobalClassObject)` · `globalVariables?: z.array(z.object({ type, label, value }))` · `confirm?: z.boolean().default(false)`.
- outputSchema: `success: z.boolean()` · `classes_order: z.array(z.string())` · `variables_watermark: z.number().int()` · `modifiedLabels?: z.record(z.string(), z.unknown())`.
- annotations: `destructiveHint:true` (overwrites design system). Side: BOTH (orchestrates `classes.upsert` + `variables.batch` + cache flush). Class: D. Elicitation confirm required.

### 1.5 Media / library (RESEARCH.md §5.5)

#### `elementor.media.sideload_url` ★
- title: "Sideload image from URL"; description: "Import an external image into the WP media library (deduped by source hash)."
- inputSchema: `url: z.string()` · `alt?: z.string()` · `title?: z.string()`.
- outputSchema: `attachment_id: z.number().int()` · `url: z.string()` · `sizes: z.record(z.string(), z.object({ url, width: z.number().int(), height: z.number().int() }))` · `deduped: z.boolean()`.
- annotations: `idempotentHint:true` (dedupe by `_elementor_source_image_hash`). Side: proxied-to-REST (`POST elementor-ultra/v1/media/sideload`). Class: M.

#### `elementor.media.upload`
- title: "Upload media"; description: "Upload raw bytes/base64 to the media library."
- inputSchema: `data: z.string()` — base64 · `filename: z.string()` · `alt?: z.string()`.
- outputSchema: `attachment_id: z.number().int()` · `url: z.string()`.
- annotations: (none). Side: proxied-to-REST (`POST elementor-ultra/v1/media/upload`). Class: M.

#### `elementor.media.list`
- title: "List media"; description: "Search/list attachments."
- inputSchema: `query?: z.string()` · `mime?: z.string()` · plus §0.6 pagination.
- outputSchema: §0.6 with `items: z.array(z.object({ id: z.number().int(), url, mime, alt, title }))`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/media`). Class: R. Pagination: yes.

### 1.6 Navigation / menus (RESEARCH.md §5.6)

#### `elementor.nav.menus.list`
- title: "List nav menus"; description: "List WP navigation menus."
- inputSchema: §0.6 pagination.
- outputSchema: §0.6 with `items: z.array(z.object({ term_id: z.number().int(), name, slug, count: z.number().int() }))`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/nav/menus`). Class: R. Pagination: yes.

#### `elementor.nav.menus.create`
- title: "Create nav menu"; description: "Create and populate a navigation menu."
- inputSchema: `name: z.string()` · `items: z.array(z.object({ title: z.string(), url: z.string().optional(), object_id: z.number().int().optional(), type: z.string().optional(), parent_index: z.number().int().optional() }))`.
- outputSchema: `term_id: z.number().int()` · `item_ids: z.array(z.number().int())`.
- annotations: (none). Side: proxied-to-REST (`POST elementor-ultra/v1/nav/menus`). Class: M.

#### `elementor.nav.bind_widget`
- title: "Bind nav widget to menu"; description: "Bind a Pro nav-menu/mega-menu widget to a menu term."
- inputSchema: `post_id: z.number().int()` · `element_id: z.string()` · `term_id: z.number().int()` · `base_hash: z.string()`.
- outputSchema: `diff: Diff` · `base_hash: z.string()`.
- annotations: `idempotentHint:true`. Side: proxied-to-REST (`PUT elementor-ultra/v1/documents/{id}/elements/{element_id}/nav-bind`). Class: M.
- Note: Pro nav-menu binds to a `nav_menu` TERM via `settings.menu` (`elementor-pro …/nav-menu.php:69,1464-1485`).

### 1.7 Templates / kits (RESEARCH.md §5.7)

#### `elementor.templates.list`
- title: "List templates"; description: "Template library list (paginated)."
- inputSchema: `type?: z.string()` · plus §0.6 pagination.
- outputSchema: §0.6 with `items: z.array(z.object({ template_id: z.number().int(), title, type, source }))`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/templates`). Class: R. Pagination: yes.

#### `elementor.templates.get`
- title: "Get template"; description: "Template content + settings."
- inputSchema: `template_id: z.number().int()`.
- outputSchema: `content: z.array(ElementNode)` · `page_settings: z.record(z.string(), z.unknown())` · `type: z.string()`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/templates/{id}`). Class: R.

#### `elementor.templates.save`
- title: "Save template"; description: "Persist a reusable block/page template (ids regenerated by Source_Local::save_item)."
- inputSchema: `title: z.string()` · `type: z.string()` · `content: z.array(ElementNode)` · `page_settings?: z.record(z.string(), z.unknown())`.
- outputSchema: `template_id: z.number().int()` · `edit_url: z.string()`.
- annotations: (none). Side: proxied-to-REST (`POST elementor-ultra/v1/templates`). Class: M.
- Note: atomic-V4 correctness is Spike S2.

#### `elementor.templates.import`
- title: "Import template"; description: "Import a .json/.zip template (image sideload + id remap)."
- inputSchema: `file_path?: z.string()` · `content?: z.unknown()` · `import_mode?: z.enum(['match_site','keep_existing']).default('match_site')`.
- outputSchema: `template_id: z.number().int()` · `remapped_ids: z.record(z.string(), z.string())`.
- annotations: (none). Side: proxied-to-REST (`POST elementor-ultra/v1/templates/import`). Class: M.

#### `elementor.templates.insert_into_page`
- title: "Insert template into page"; description: "Paste a block into a document (ids minted fresh)."
- inputSchema: `post_id: z.number().int()` · `template_id?: z.number().int()` · `content?: z.array(ElementNode)` · `parent_id?: z.string()` · `index?: z.number().int()` · `base_hash: z.string()`.
- outputSchema: `diff: Diff` · `base_hash: z.string()`.
- annotations: (none). Side: proxied-to-REST (`POST elementor-ultra/v1/documents/{id}/insert-template`). Class: M.

#### `elementor.kit.export`
- title: "Export kit"; description: "Full-site kit export zip."
- inputSchema: `include: z.array(z.enum(['content','templates','settings','plugins']))` · `kitInfo?: z.record(z.string(), z.unknown())` · `customization?: z.record(z.string(), z.unknown())`.
- outputSchema: `file_path: z.string()` · `session: z.string()`.
- annotations: `readOnlyHint:true`. Side: proxied-to-REST (`POST elementor-ultra/v1/kit/export`). Class: R.

#### `elementor.kit.import`
- title: "Import kit"; description: "Upload + import a kit zip."
- inputSchema: `session?: z.string()` · `file?: z.string()` · `include: z.array(z.string())` · `customization?: z.record(z.string(), z.unknown())` · `confirm?: z.boolean().default(false)`.
- outputSchema: `session: z.string()` · `imported: z.record(z.string(), z.unknown())`.
- annotations: `destructiveHint:true`. Side: proxied-to-REST (`POST elementor-ultra/v1/kit/import`). Class: D. Elicitation confirm required.

#### `elementor.kit.revert`
- title: "Revert kit import"; description: "Revert a kit import session."
- inputSchema: `session: z.string()` · `confirm?: z.boolean().default(false)`.
- outputSchema: `success: z.boolean()`.
- annotations: `destructiveHint:true`. Side: proxied-to-REST (`POST elementor-ultra/v1/kit/revert`). Class: D. Elicitation confirm required.

### 1.8 Pro surface (RESEARCH.md §5.8; SUPPLEMENT.md §A.7)

All Pro tools are proxied-to-REST against `elementor-ultra/v1/pro/*`; PHP wraps `Document::save()` + correct `_elementor_template_type` + Pro APIs (`Conditions_Manager::save_conditions()`, `save_display_settings_data()`).

#### `elementor.pro.theme.create`
- title: "Create theme-builder doc"; description: "Create a header/footer/single/archive/404/search/section theme-builder document with conditions."
- inputSchema: `type: z.enum(['header','footer','single-post','single-page','archive','search-results','error-404','section'])` · `title: z.string()` · `status?: z.enum(['publish','draft']).default('publish')` · `location?: z.string()` — required only when `type='section'` · `elements?: z.array(ElementNode)` · `page_settings?: z.record(z.string(), z.unknown())` · `conditions?: z.array(ConditionTuple)`.
- outputSchema: `post_id: z.number().int()` · `edit_url: z.string()` · `template_type: z.string()` · `location: z.string().nullable()` · `conditions_stored: z.array(z.string())`.
- annotations: (none). Side: proxied-to-REST (`POST elementor-ultra/v1/pro/theme`). Class: M.
- Note: reject `type='single'` (hidden/legacy). `ConditionTuple = z.tuple([z.enum(['include','exclude']), z.string()]).rest(z.string())` (slash-joined server-side). SUPPLEMENT.md §A.1, §A.7.

#### `elementor.pro.theme.set_conditions`
- title: "Set display conditions"; description: "Replace all display conditions on a theme doc (via Conditions_Manager::save_conditions + cache regenerate)."
- inputSchema: `post_id: z.number().int()` · `conditions: z.array(ConditionTuple)` · `check_conflicts?: z.boolean().default(false)`.
- outputSchema: `saved: z.boolean()` · `conditions_stored: z.array(z.string())` · `conflicts?: z.array(z.object({ template_id, template_title, edit_url }))`.
- annotations: `idempotentHint:true`. Side: proxied-to-REST (`PUT elementor-ultra/v1/pro/theme/{id}/conditions`). Class: M.
- Note: `[]` clears all. Writes slash strings + `cache->regenerate()` (SUPPLEMENT.md §A.1: `conditions-manager.php:300-323`).

#### `elementor.pro.theme.get_conditions_config`
- title: "Get conditions config"; description: "Valid condition keys / sub-conditions per location (autocomplete tree)."
- inputSchema: `{}`.
- outputSchema: `tree: z.record(z.string(), z.unknown())` · `locations: z.array(z.string())`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/pro/theme/conditions-config`). Class: R.
- Provenance: `pro.theme.get_conditions_config` SUPERSEDES SUPPLEMENT §A.7's `pro.theme.list_condition_options` — same source (`get_conditions_config()` tree), renamed for clarity. The SUPPLEMENT §A.7 alias is intentionally NOT a separate tool; cross-checking §A.7 against this catalog will find the capability under this name.

#### `elementor.pro.popup.create`
- title: "Create popup"; description: "Create a popup document with layout settings, display settings (triggers/timing), and conditions."
- inputSchema: `title: z.string()` · `status?: z.enum(['publish','draft']).default('publish')` · `elements?: z.array(ElementNode)` · `layout_settings?: z.record(z.string(), z.unknown())` · `display_settings?: z.object({ triggers: z.record(z.string(), z.unknown()).optional(), timing: z.record(z.string(), z.unknown()).optional() })` · `conditions?: z.array(ConditionTuple)`.
- outputSchema: `post_id: z.number().int()` · `edit_url: z.string()` · `conditions_stored: z.array(z.string())`.
- annotations: (none). Side: proxied-to-REST (`POST elementor-ultra/v1/pro/popup`). Class: M.
- Note: display settings → `_elementor_popup_display_settings` via `save_display_settings_data()`; popup attaches to location `popup` (multiple=true). SUPPLEMENT.md §A.2, §A.7.

#### `elementor.pro.popup.set_triggers` / `.set_timing`
- title: "Set popup {triggers|timing}"; description: "Merge into the existing `_elementor_popup_display_settings`."
- inputSchema: `post_id: z.number().int()` · (`triggers` | `timing`)`: z.record(z.string(), z.unknown())`.
- outputSchema: `success: z.boolean()` · `display_settings: z.record(z.string(), z.unknown())`.
- annotations: `idempotentHint:true`. Side: proxied-to-REST (`PUT elementor-ultra/v1/pro/popup/{id}/{triggers|timing}`). Class: M.

#### `elementor.pro.form.build`
- title: "Build form widget"; description: "Build an Elementor form widget (V3 classic `form`, or atomic `e-form` when `e_pro_atomic_form` active) with fields + actions."
- inputSchema: `container_id: z.string()` · `post_id: z.number().int()` · `form_name?: z.string()` · `button_text?: z.string()` · `fields: z.array(z.object({ type: z.string(), id: z.string(), label: z.string().optional(), placeholder: z.string().optional(), required: z.boolean().optional(), options: z.array(z.object({ label, value })).optional(), rows: z.number().int().optional(), width: z.string().optional(), default_value: z.string().optional(), html: z.string().optional() }))` · `actions: z.array(z.object({ type: z.enum(['email','email2','redirect','webhook','mailchimp','drip','activecampaign','getresponse','convertkit','mailerlite','slack','discord']) }).passthrough())` · `base_hash: z.string()`.
- outputSchema: `element: ElementNode` · `diff: Diff` · `warnings: z.array(z.string())` · `base_hash: z.string()`.
- annotations: (none). Side: BOTH (TS maps spec→widget; PHP validates action registration via `actions_registrar->get()` + field-type filter). Class: M.
- Note: `required`→string `"true"`; `id`→`custom_id` (unique, `[A-Za-z0-9_]`); `options`→`Label|value\n…`. SUPPLEMENT.md §A.3, §A.7.

#### `elementor.pro.form.list_actions`
- title: "List form actions"; description: "Registered (license-gated) form actions and their settings controls."
- inputSchema: `{}`.
- outputSchema: `actions: z.array(z.object({ name, label, settings_controls: z.array(z.string()) }))`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/pro/form/actions`). Class: R.

#### `elementor.pro.loop.create_item`
- title: "Create loop item"; description: "Create a loop-item template document."
- inputSchema: `title: z.string()` · `elements?: z.array(ElementNode)`.
- outputSchema: `template_id: z.number().int()` · `edit_url: z.string()`.
- annotations: (none). Side: proxied-to-REST (`POST elementor-ultra/v1/pro/loop/item`). Class: M.

#### `elementor.pro.loop.bind_grid`
- title: "Bind loop grid"; description: "Configure a loop-grid/carousel widget bound to a loop-item template + query."
- inputSchema: `container_id: z.string()` · `post_id: z.number().int()` · `widget?: z.enum(['loop-grid','loop-carousel']).default('loop-grid')` · `template_id: z.number().int()` · `skin?: z.enum(['post','post_taxonomy','product','product_taxonomy']).default('post')` · `columns?: z.number().int()` · `posts_per_page?: z.number().int().default(6)` · `query: z.object({ post_type: z.string(), orderby: z.string().optional(), order: z.enum(['asc','desc']).optional(), include_term_ids: z.array(z.string()).optional(), exclude_ids: z.array(z.string()).optional(), posts_ids: z.array(z.string()).optional(), query_id: z.string().optional() })` · `pagination?: z.object({ type: z.string(), load_type: z.string() })` · `base_hash: z.string()`.
- outputSchema: `element: ElementNode` · `diff: Diff` · `base_hash: z.string()`.
- annotations: (none). Side: BOTH (PHP asserts `template_id._elementor_template_type=='loop-item'`). Class: M.
- Note: query keys prefixed `{skin}_query_`; `posts_per_page` is TOP-LEVEL (NOT `post_query_posts_per_page`). SUPPLEMENT.md §A.4, §A.7.

#### `elementor.pro.dynamic.bind`
- title: "Bind dynamic tag (Pro)"; description: "Byte-identical mirror of core Manager::tag_to_text for dynamic binding."
- inputSchema: `post_id: z.number().int()` · `element_id: z.string()` · `control: z.string()` · `tag: z.string()` · `tag_settings?: z.record(z.string(), z.unknown())` · `fallback_value?: z.unknown()` · `base_hash: z.string()`.
- outputSchema: `dynamic_string: z.string()` · `diff: Diff` · `applied: z.boolean()` · `base_hash: z.string()`.
- annotations: `idempotentHint:true`. Side: BOTH. Class: M.
- Note: validates `control.dynamic.active==true`, tag registered, tag category ∩ control categories. SUPPLEMENT.md §A.6, §A.7.

#### `elementor.pro.dynamic.list_tags`
- title: "List dynamic tags (Pro)"; description: "Per-tag name/title/group/categories/settings controls/availability."
- inputSchema: §0.6 pagination.
- outputSchema: §0.6 with `items: z.array(z.object({ name, title, group, categories: z.array(z.string()), settings_controls: z.array(z.string()), available: z.boolean() }))`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/pro/dynamic/tags`). Class: R. Pagination: yes.

#### `elementor.pro.woo.add_widget`
- title: "Add WooCommerce widget"; description: "Add a context-validated WooCommerce widget (single/archive/context-free)."
- inputSchema: `post_id: z.number().int()` · `container_id: z.string()` · `widget: z.string()` — `woocommerce-*` / `wc-*` · `product_id?: z.number().int()` — for `wc-add-to-cart` · `settings?: z.record(z.string(), z.unknown())` · `base_hash: z.string()`.
- outputSchema: `element: ElementNode` · `diff: Diff` · `context_ok: z.boolean()` · `context_warning?: z.string()` · `base_hash: z.string()`.
- annotations: (none). Side: BOTH (PHP classifies by `get_categories()`; single → require Single-Product doc; archive → require Shop/Archive doc). Class: M.
- Note: deferred to ULTRA; context-validation contract specified now (SUPPLEMENT.md §A.5).

### 1.9 HTML → native conversion (flagship — RESEARCH.md §5.9, §6)

#### `elementor.convert.html_to_tree` ★
- title: "Convert HTML to element tree"; description: "Convert HTML+CSS into a native atomic element tree with proposed classes/variables and a coverage report (NO persistence)."
- inputSchema: `html: z.string()` · `css?: z.string()` · `generation?: z.enum(['v4','v3']).default('v4')` · `options?: z.object({ hoist_classes: z.boolean().default(true), extract_variables: z.boolean().default(true), fidelity: z.enum(['high','balanced','fast']).default('balanced'), sideload_media: z.boolean().default(true), base_url: z.string().optional() })` — `base_url` resolves relative URLs + external stylesheet hrefs during parse/normalize (without it `<link rel=stylesheet>` is unresolvable → `EXTERNAL_CSS_UNRESOLVED`, and relative media cannot sideload).
- outputSchema: `elements: z.array(ElementNode)` · `proposed_classes: z.array(GlobalClassObject)` · `proposed_variables: z.array(z.object({ type, label, value }))` · `report: z.object({ coverage: z.object({ native_pct: z.number(), class_pct: z.number(), custom_css_pct: z.number(), dropped_pct: z.number() }), fallbacks: z.array(z.object({ node_id, declaration, tier: z.string() })), a11y: z.array(z.object({ node_id, rule, severity: z.enum(['warn','block']), message })), stripped_text: z.array(z.object({ node_id, tags: z.array(z.string()) })) })`.
- annotations: `readOnlyHint:true`. Side: TS (Playwright render-then-extract; §6.1, SUPPLEMENT.md §C.3-C.4). Class: R.

#### `elementor.convert.html_to_page` ★
- title: "Convert HTML to page"; description: "Convert HTML, sideload media, create classes/variables, validate, and (only on explicit commit) create/replace the page + prime CSS. NEVER auto-commits."
- inputSchema: `html: z.string()` · `css?: z.string()` · `post_id?: z.number().int()` · `title?: z.string()` · `status?: z.enum(['draft','publish','pending','private'])` (publish state for a NEWLY created page; ignored when replacing an existing `post_id`; defaults to `draft`) · `generation?: z.enum(['v4','v3']).default('v4')` · `commit?: z.boolean().default(false)` · `confirm?: z.boolean().default(false)` · `coverage_gate?: z.number().min(0).max(1).optional()` · `options?` — the SAME options bag as `html_to_tree` (incl. `base_url`), threaded into the shared stage run.
- outputSchema: `id?: z.number().int()` · `diff: Diff` · `preview_url: z.string()` · `report: z.unknown()` (same shape as `html_to_tree.report`) · `committed: z.boolean()` · `css_primed: z.boolean()`.
- annotations: `destructiveHint:true` (when `commit:true` against existing `post_id`). Side: BOTH. Class: M (new page) / D (replace). Elicitation confirm required when committing.
- Note: pipeline = `html_to_tree` (stages 1-9 incl. media sideload, then resolves placeholders to deterministic class/variable ids — the tree is persistable as-is) → on `commit:true`: gate → elicitation confirm → capability probe → `page.dry_run` (authoritative, BEFORE any kit write — `valid:false` ⇒ ZERO classes/variables created) → variables batch (PHP-minted ids) → `classes.upsert` (diff PUT, budget, under the tree's deterministic ids — replay-stable) → variable-id swap (deterministic → minted, one pass) → save (`page.create` or replace-tree w/ fresh `base_hash`; a save failure compensates the just-landed kit writes — deletes the added classes + created variables — then rethrows) → prime-css (mandatory). Below `coverage_gate` or with a11y blockers → returns report, refuses commit (RESEARCH.md §6.8). LOCKED: never auto-commits.

#### `elementor.convert.fidelity_check`
- title: "Fidelity check"; description: "Render the saved page and visual-compare against the source HTML (pixelmatch)."
- inputSchema: `post_id: z.number().int()` · `source_html: z.string()` · `breakpoints?: z.array(z.string())`.
- outputSchema: `score: z.number()` · `deltas: z.array(z.object({ breakpoint, diff_ratio: z.number(), region: z.string().nullable() }))`.
- annotations: `readOnlyHint:true`. Side: BOTH (TS Playwright screenshot vs. rendered preview URL). Class: R.

### 1.10 Ops / observability (RESEARCH.md §5.10)

#### `elementor.ops.log`
- title: "Operation audit log"; description: "Audit trail of writes (op_id, before/after hashes, result)."
- inputSchema: `post_id?: z.number().int()` · `user?: z.string()` · plus §0.6 pagination.
- outputSchema: §0.6 with `items: z.array(z.object({ op_id, post_id: z.number().int().nullable(), user, tool, before_hash, after_hash, result, ts: z.string() }))`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: proxied-to-REST (`GET elementor-ultra/v1/ops/log`). Class: R. Pagination: yes.

#### `elementor.batch.plan`
- title: "Plan multi-doc build"; description: "Dry-plan a multi-document brief build (records required backups)."
- inputSchema: `steps: z.array(z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()) }))`.
- outputSchema: `plan: z.array(z.object({ step_index: z.number().int(), tool, input: z.record(z.string(), z.unknown()), target: z.string().nullable(), action: z.string(), valid: z.boolean().optional(), errors: z.array(z.record(z.string(), z.unknown())).optional() }))` · `backups_required: z.array(z.string())` · `valid: z.boolean()`. Each plan row carries the step's ORIGINAL `input` through the plan→apply round trip (`batch.apply` rebuilds the REST bodies from it); per-row `valid`/`errors` surface the authoritative PHP `/batch/plan` per-step verdict (10-rest-api.md §0.9; absent ⇒ not validated) and the top-level `valid` is the aggregate (AND of every step).
- annotations: `readOnlyHint:true`. Side: BOTH. Class: R.

#### `elementor.batch.apply`
- title: "Apply multi-doc plan"; description: "Execute a multi-document plan with up-front backups and best-effort compensation on partial failure."
- inputSchema: `plan: z.array(z.unknown())` · `op_id?: z.string()` · `confirm?: z.boolean().default(false)`.
- outputSchema: `results: z.array(z.object({ step_index: z.number().int(), ok: z.boolean(), output: z.unknown().nullable(), error: z.string().nullable(), compensated: z.boolean() }))`.
- annotations: `destructiveHint:true, idempotentHint:true` (with `op_id`). Side: BOTH. Class: D. Elicitation confirm required.

### 1.11 Meta-tool trio (long-tail access — RESEARCH.md §5.11)

For the Pro/Woo long tail, an invoke-by-name path exists so disabled tools are reachable without enabling them all:

#### `elementor.tools.list_endpoints`
- title: "List tool endpoints"; description: "Enumerate every tool (incl. disabled) with namespace + safety class."
- inputSchema: `prefix?: z.string()` · plus §0.6 pagination.
- outputSchema: §0.6 with `items: z.array(z.object({ name, title, class: z.enum(['R','M','D']), enabled: z.boolean(), star: z.boolean() }))`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: TS. Class: R.

#### `elementor.tools.get_schema`
- title: "Get tool schema"; description: "Return the input/output schema + annotations for a named tool."
- inputSchema: `name: z.string()`.
- outputSchema: `name` · `inputSchema: z.unknown()` · `outputSchema: z.unknown()` · `annotations: z.unknown()`.
- annotations: `readOnlyHint:true, idempotentHint:true`. Side: TS. Class: R.

#### `elementor.tools.invoke`
- title: "Invoke tool by name"; description: "Invoke any catalog tool (incl. disabled) by name with a payload; mirrors the named tool's safety class + confirm gating."
- inputSchema: `name: z.string()` · `arguments: z.record(z.string(), z.unknown())`.
- outputSchema: `result: z.unknown()` · `isError: z.boolean()`.
- annotations: (none — inherits the target's effective annotations at call time). Side: TS dispatch (then the target tool's side). Class: inherits target.

---

## 2. Resources (`elementor://...`) (RESEARCH.md §5.1, §5.4, §5.7)

All resources are read-only, paginated via cursor where they back a collection, and resolved through the same App-Password REST client.

| URI template | Name | Returns | MIME | Backing |
|---|---|---|---|---|
| `elementor://site/capabilities` | Site capabilities | same shape as `site.capabilities` output | `application/json` | `GET .../site/capabilities` |
| `elementor://breakpoints` | Breakpoints | breakpoint list | `application/json` | `GET .../breakpoints` |
| `elementor://schema/styles` | Style-Schema | flat style-prop table | `application/json` | `GET .../schema/styles` |
| `elementor://schema/widget/{type}` | Widget schema | per-widget post-filter schema | `application/json` | `GET .../schema/widget/{type}` |
| `elementor://page/{id}/structure` | Page structure | element tree + base_hash | `application/json` | `GET .../documents/{id}/structure` |
| `elementor://kit/global-classes` | Global classes | classes + order | `application/json` | `GET .../design/classes` |
| `elementor://kit/variables` | Variables | tokens + watermark | `application/json` | `GET .../design/variables` |
| `elementor://kit/global-colors` | V3 global colors | system+custom colors | `application/json` | `GET .../design/global-colors` |
| `elementor://kit/element-defaults` | Element defaults | per-widget defaults map | `application/json` | `GET .../design/element-defaults` |
| `elementor://templates` | Template library | template list | `application/json` | `GET .../templates` |

Resource registration uses `ResourceTemplate` for the `{type}`/`{id}` parametric URIs and `registerResource` for the static ones. Each resource declares a `list` callback where it backs an enumerable collection.

---

## 3. Prompts (RESEARCH.md §9.1 ULTRA, §5)

Prompts are registered via `server.registerPrompt(name, { title, description, argsSchema }, handler)`. `argsSchema` is a ZodRawShape of string args (MCP prompt args are strings).

### `build-from-brief`
- title: "Build a page from a brief"; description: "Guide the agent to turn a natural-language brief into a validated `page.build` call (probe capabilities, choose V4/V3, dry-run, prime CSS)."
- argsSchema: `brief: z.string()` · `post_type?: z.string()` · `generation?: z.string()`.
- Behavior: emits a structured plan referencing `site.capabilities` → `schema.widget`/`schema.styles` → `page.dry_run` → `page.build`. Never invents Elementor props; instructs use of `schema.*` first.

### `html-to-native`
- title: "Convert HTML to native Elementor"; description: "Drive `convert.html_to_tree` → review report → confirm → `convert.html_to_page` with explicit commit. NEVER auto-commit."
- argsSchema: `html: z.string()` · `css?: z.string()` · `coverage_gate?: z.string()`.
- Behavior: enforces the dry-run + diff + coverage-report + explicit-commit flow (LOCKED, RESEARCH.md §6.8).

### `design-system-audit`
- title: "Audit the design system"; description: "Read classes + variables + V3 globals, report duplication/budget/coverage, and propose consolidating `design.classes.upsert`/`variables.batch` operations."
- argsSchema: `scope?: z.string()` (`classes|variables|all`).
- Behavior: reads via `design.classes.list`/`design.variables.list`/`design.globalColors.list`; flags the 1000-item budget and duplicate labels.

### `theme-builder-from-spec`
- title: "Build a theme-builder template from a spec"; description: "Create header/footer/single/archive/popup docs and attach correct display conditions via `pro.theme.*`/`pro.popup.*`."
- argsSchema: `spec: z.string()` · `theme_type?: z.string()`.
- Behavior: probes `pro` presence + `pro.theme.get_conditions_config`; uses `ConditionTuple` form; reminds that conditions write slash strings + regenerate cache.

---

## 4. Side-of-implementation summary (LOCKED)

- **TS-only (no proxied REST core work):** `tools.search`, `tools.list_endpoints`, `tools.get_schema`, `tools.invoke`, `convert.html_to_tree`.
- **proxied-to-REST:** all `site.*`, `pages.*`, `page.*` (except `page.build`), `element.*`, `widget.*`, `schema.*`, `breakpoints.*`, `dynamic.*`, `design.*` (except `design.deploy`), `media.*`, `nav.*`, `templates.*`, `kit.*`, `pro.theme.create/set_conditions/get_conditions_config`, `pro.popup.*`, `pro.form.list_actions`, `pro.loop.create_item`, `pro.dynamic.list_tags`, `ops.log`.
- **BOTH (orchestration + REST):** `page.build`, `page.dry_run` (TS pre-filter then PHP authoritative), `design.deploy`, `pro.form.build`, `pro.loop.bind_grid`, `pro.dynamic.bind`, `pro.woo.add_widget`, `convert.html_to_page`, `convert.fidelity_check`, `batch.plan`, `batch.apply`.

---

## 5. Large-surface ergonomics (LOCKED — RESEARCH.md §5.11)

### 5.1 Namespacing
Every tool dot-prefixed under `elementor.`; names match `^[A-Za-z0-9_.-]{1,128}$`; namespace segments per §0.2.

### 5.2 Lean default profile (★ STAR SET — the ~25 tools loaded statically)

The following are enabled at boot; all other tools are registered then `disable()`d (surfaced via `tools.search` / `tools.list_endpoints`):

1. `elementor.tools.search`
2. `elementor.site.capabilities`
3. `elementor.pages.list`
4. `elementor.page.get_structure`
5. `elementor.page.create`
6. `elementor.page.build`
7. `elementor.page.dry_run`
8. `elementor.schema.widget`
9. `elementor.schema.styles`
10. `elementor.breakpoints.get`
11. `elementor.widget.insert`
12. `elementor.widget.update_settings`
13. `elementor.design.classes.list`
14. `elementor.design.classes.upsert`
15. `elementor.design.variables.list`
16. `elementor.media.sideload_url`
17. `elementor.convert.html_to_tree`
18. `elementor.convert.html_to_page`

(18 star tools; the lean profile sits at the low end of the ~25-40 band so heavy clients stay responsive. The meta-tool trio `tools.list_endpoints`/`tools.get_schema`/`tools.invoke` is always available regardless of profile.)

### 5.3 Dynamic enable + listChanged
- Advanced tools are `disable()`d at boot. `tools.search` (or `tools.invoke`) `enable()`s the matched tools and the server calls `sendToolListChanged()` so honoring clients refresh.
- `tools.invoke` allows calling a disabled tool without persistently enabling it (for one-shot long-tail use).

### 5.4 Static-profile env fallback
- `ULTRA_TOOLS=full` → register ALL tools enabled (for clients that ignore `listChanged`).
- `ULTRA_TOOLS=lean` (default) → only the ★ set + meta-trio enabled at boot.
- The env var is read once at server init in `packages/server/src/server.ts`.

### 5.5 Pagination everywhere
All list/read tools accept `{limit,cursor,fields[]}` and return `{items,next_cursor,total}` (§0.6). `page.get_structure` additionally accepts `depth`/`subtree_id`/`projection='summary'` to avoid context blowups.

### 5.6 Batch vs granular
- Greenfield: `page.build` / `convert.html_to_page`.
- Surgical idempotent refactors: granular `widget.*` / `element.*` (base_hash + op_id).
- Multi-doc briefs: `batch.plan` / `batch.apply` with compensation.

---

## 6. Spike gating of tools (LOCKED — RESEARCH.md §0, §9.1)

- Any tool that persists an atomic tree and reports CSS-rendered output (`page.build`, `page.replace_tree`, `convert.html_to_page`) depends on the prime-css capability and is gated on Spike S1.
- `templates.save`/`insert_into_page` atomic correctness is gated on Spike S2.
- `convert.*` coverage thresholds anchor to Spike S3 (no hardcoded 85%).
- `page.update_settings` merge semantics are gated on Spike S4 (until then GET-merge-PUT).
- `design.classes.*` capability availability requires the `UPDATE_CLASS` grant (companion activation) and is probed via `site.capabilities` (Spike S5).
