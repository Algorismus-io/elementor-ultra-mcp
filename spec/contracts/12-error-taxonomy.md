# Contract 12 — Error Taxonomy (FROZEN)

> Status: **FROZEN**. A stable, enumerated set of error codes shared across the TS MCP server and the
> PHP companion plugin. Every error the system surfaces MUST carry one of these `code` values and the
> structured payload shape in §2. WP-F05 realizes this as a shared TS enum + JSON Schema + PHP
> constants; WP-T (server core) maps these to MCP results; WP-P (plugin) emits them from
> `permission_callback`s and the validator.
>
> Grounded in: RESEARCH.md §7.5 (error semantics: `-32602` vs `isError`), §2.1/§2.2 (atomic throws,
> diff-PUT, `DUPLICATED_LABEL`, `MAX_ITEMS`), §8 (capabilities, experiments, App Passwords), §5.4
> (budget). Source `path:line` relative to `plugins/elementor` / `plugins/elementor-pro`.

## 1. Two-axis mapping: protocol vs result

Every error resolves on TWO axes (RESEARCH.md §7.5):

1. **MCP surface** — one of:
   - **`protocol`** → a JSON-RPC error. **`-32602` Invalid params** for argument/schema validation
     failures (the request was malformed). `-32601` for unknown method, `-32603` for internal. The
     SDK throws/returns these from the protocol layer.
   - **`isError`** → a normal tool *result* with `isError:true` and actionable text. Use this for
     **runtime/business** failures the agent can fix or react to (missing atomic prop, invalid
     widgetType, lock held, autosave conflict, budget exceeded, capability missing). Map PHP
     `WP_Error` / caught `\Exception` to `isError` text (WITH structured parser errors), NOT protocol
     errors, when the agent can correct the input.
2. **Retryability** — `retryable:true` means an identical or backoff retry MAY succeed (transient:
   lock held, concurrency race, rate limit). `retryable:false` means the input or environment must
   change first.

**Rule of thumb:** schema/shape wrong → `protocol -32602`. Everything else → `isError` result.

## 2. Structured payload shape

Every error (whether surfaced as `isError` text or carried in a `DryRunResult.errors[]` /
`Diff.design_system.modified_labels`) serializes to this shape. This is the frozen
`McpErrorPayload` (TS) / `ErrorPayload` (PHP) type owned by WP-F05; it aligns with
`schemas/diff.schema.json#/$defs/ValidationError`.

    {
      "code": "ATOMIC_SETTINGS_INVALID",        // one of §3
      "message": "Human, actionable. Includes appended parser errors verbatim.",
      "http_status": 422,                         // the REST status the plugin returned (informational)
      "retryable": false,
      "surface": "isError",                       // "protocol" | "isError"
      "rpc_code": null,                           // set only when surface=="protocol", e.g. -32602
      "meta": {                                   // code-specific structured context (see §3)
        "element_id": "abc1234",
        "style_id": "e-abc1234-7f3a9c2",
        "prop": "padding"
      }
    }

`meta` is an open object; each code documents its expected keys in §3. The TS server renders the
`message` + a compact `meta` summary into the `isError` result text and ALSO returns the full payload
as structured content where the client supports it.

## 3. Error code catalog (frozen)

Codes are `SCREAMING_SNAKE_CASE`, stable forever. `http_status` is what the PHP route returns
(informational for `protocol`/TS-only codes). `surface` is the default; a code may be re-surfaced as
`protocol` only when the failure is genuinely a malformed request.

### 3.1 Validation / authoring

| code | http | retryable | surface | meaning & source | meta keys |
|---|---|---|---|---|---|
| `VALIDATION_FAILED` | 422 | no | isError | Generic structural pre-filter failure (TS) or aggregate dry_run failure. Carries `errors[]`. | `errors[]` |
| `SCHEMA_INVALID_PARAMS` | 400 | no | protocol (`-32602`) | Tool arguments don't match the tool `inputSchema`. SDK/Zod layer. | `path`, `expected` |
| `ATOMIC_SETTINGS_INVALID` | 422 | no | isError | `Props_Parser` threw: "Settings validation failed." + parser errors (`has-atomic-base.php:113`). One bad prop aborts the whole save. **Do NOT string-match the message; catch the `\Exception`.** | `element_id`, `prop`, `parser_errors` |
| `ATOMIC_STYLES_INVALID` | 422 | no | isError | `Style_Parser` threw: "Styles validation failed for style `<id>`. Widget ID: `<id>`. " + parser errors (`has-atomic-base.php:97`). | `element_id`, `style_id`, `parser_errors` |
| `UNKNOWN_WIDGET_TYPE` | 422 | no | isError | `widgetType`/`elType` not registered on target. Legacy nodes silently drop; atomic nodes throw. Probe `schema/registered-types`. | `element_id`, `requested_type` |
| `DUPLICATE_ELEMENT_ID` | 422 | no | isError | Two nodes share an id (collides on `.elementor-element-<id>`). Use `ids/remap`. | `element_id` |
| `LOCAL_STYLE_UNLINKED` | 422 | no | isError | A `styles` map id is not present in the owning element's `classes` prop (would silently detach). | `element_id`, `style_id` |
| `IMAGE_SRC_XOR_VIOLATION` | 422 | no | isError | `image-src` had both or neither `id`/`url` (`image-src-prop-type.php:36-44`). | `element_id`, `prop` |
| `HTML_V3_STRIPPED` | 200 | no | isError (soft) | Inner markup contained non-allowlisted tags that `wp_kses` strips (`html-v3-prop-type.php:91`). Reported in `CoverageReport.stripped_text`; non-fatal but agent should promote block content. | `element_id`, `stripped_tags[]` |
| `SETTINGS_INVALID` | 422 | no | isError | DOCUMENT-settings allowlist violation (contract 18 §7-AI S1, kills AF1): a known page-settings key carries a render-fatal shape — `custom_css` MUST be a plain string (the object `{raw}` shape is the STYLE-variant form; on page settings it fatals Pro's `trim()`), `template` must be in the page-template enum, `hide_title` must be boolean(-ish), `post_status` must be a valid status. Unknown keys pass through. | `key`, `expected`, `received` |

### 3.2 Concurrency / safety

| code | http | retryable | surface | meaning & source | meta keys |
|---|---|---|---|---|---|
| `LOCK_HELD` | 409 | yes | isError | `wp_check_post_lock($id)` returned a holder; refuse unless `force=true` (core save ignores locks, RESEARCH.md §7). | `post_id`, `locked_by`, `locked_until` |
| `AUTOSAVE_CONFLICT` | 409 | yes | isError | `get_newer_autosave()` exists; `base_hash` can pass while an autosave conflict exists (`document.php:556-602`). Refuse unless `force=true`. | `post_id`, `autosave_user`, `autosave_ts` |
| `CONCURRENCY_STALE_HASH` | 409 | yes | isError | Optimistic lock: `md5(_elementor_data) != base_hash`. Re-read `get_structure` for a fresh `base_hash`. | `post_id`, `expected_hash`, `actual_hash` |
| `IDEMPOTENT_REPLAY` | 200 | no | isError (informational) | An `op_id` was already applied; the write was a no-op. Not a failure — returned so the agent stops retrying. | `op_id`, `post_id` |

### 3.3 Design system / budget

| code | http | retryable | surface | meaning & source | meta keys |
|---|---|---|---|---|---|
| `BUDGET_EXCEEDED` | 400 | no | isError | Global classes OR variables would exceed `MAX_ITEMS=1000` (`global-classes-rest-api.php:331-341`, `global_classes_limit_exceeded`). Pre-flight `count(existing) − deleted + added ≤ 1000`. | `current_count`, `max_allowed`, `kind` (classes\|variables) |
| `DUPLICATED_LABEL` | 200 | no | isError (soft) | Diff-PUT auto-renamed a duplicate global-class label (`global-classes-rest-api.php:382-387`). Agent MUST reconcile (rebind elements to the renamed id/label). Carried in `Diff.design_system.modified_labels`. | `modified_labels` (`{id:{modified}}`) |
| `INVALID_ORDER` | 400 | no | isError | Diff-PUT `order` array is not the full, consistent final id list (`global-classes-rest-api.php:366-372`). GET current order first, then patch. | `expected_ids`, `received_ids` |
| `WATERMARK_STALE` | 409 | yes | isError | Variables batch op used a stale `watermark` (optimistic-concurrency token). Re-read `variables.list` for the current watermark. | `expected_watermark`, `actual_watermark` |

### 3.4 Capabilities / experiments / auth

| code | http | retryable | surface | meaning & source | meta keys |
|---|---|---|---|---|---|
| `CAPABILITY_MISSING` | 403 | no | isError | `current_user_can(<cap>)` failed. Notably `UPDATE_CLASS` (`elementor_global_classes_update_class`) is migration-granted to `administrator` only (`add-capabilities.php:14,24`) → 403 on ALL global-class writes if absent. The plugin grants it idempotently on activation (WP-P01); still probe `site/capabilities`. | `capability`, `user_id` |
| `EXPERIMENT_INACTIVE` | 409 | no | isError | A required experiment is off, so the route/feature does not exist. Slugs: `e_atomic_elements` (BETA/default-inactive w/ new-site override), `e_classes`, `e_variables`, `e_opt_in_v4_page`, `e_pro_atomic_form`, `e_wp_abilities_api`. Probe `site/capabilities` before assuming any route. | `experiment`, `required_for` |
| `AUTH_FAILED` | 401 | no | isError | App-Password Basic auth rejected (bad/expired credential, or `wp_is_application_passwords_available()` false over plain HTTP, S6/RESEARCH.md §8). | `reason` |
| `PRO_REQUIRED` | 409 | no | isError | A Pro-only surface was requested but Elementor Pro is inactive / license-gated (e.g. forms action not in `actions_registrar->get()`, `custom_css.raw`). | `feature` |
| `WOO_CONTEXT_INVALID` | 422 | no | isError | A WooCommerce widget was placed outside its required theme-builder context (single-product / archive), per SUPPLEMENT §A.5. | `widget`, `required_context`, `actual_doc_type` |

### 3.5 Resource / lifecycle

| code | http | retryable | surface | meaning & source | meta keys |
|---|---|---|---|---|---|
| `NOT_FOUND` | 404 | no | isError | post_id / template_id / element_id / attachment_id / class id / variable id does not exist. | `resource`, `id` |
| `NOT_EDITABLE` | 403 | no | isError | `!is_editable_by_current_user()` for the document (`document.php:821`). | `post_id` |
| `CSS_PRIME_FAILED` | 500 | yes | isError | The mandatory V4 atomic prime-css step (WP-P04 / S1) failed to emit per-breakpoint CSS; page may render unstyled. | `post_id`, `approach` (loopback\|programmatic) |
| `RENDER_FAILED` | 200 | no | isError (soft) | Post-save render verification failed (contract 18 §7-AI S2, kills AF2): the permalink probe (in-process loopback, with the MANDATORY direct front-controller dispatch fallback) saw a non-2xx/3xx status, a fatal marker, or an in-process throw. The save itself SUCCEEDED — `render_verified:false` rides the result next to `css_primed` and is op-logged. | `post_id`, `method` (loopback\|dispatch), `http_status`, `fatal` |
| `IMPORT_REMAP_FAILED` | 422 | no | isError | Template/kit import could not remap ids / global-class relations (S2-adjacent, RESEARCH.md §10 OQ#8). | `template_id` |
| `RATE_LIMITED` | 429 | yes | isError | Upstream WP/host rate limit. | `retry_after` |
| `UPSTREAM_ERROR` | 502 | yes | isError | The WP site returned an unexpected non-2xx the plugin could not classify. | `status`, `body_excerpt` |
| `INTERNAL_ERROR` | 500 | no | protocol (`-32603`) | Unhandled server-side fault (TS or PHP). | `trace_id` |

## 4. PHP `WP_Error` ↔ code mapping (plugin contract)

The companion plugin returns `WP_Error` with a `code` slug that maps 1:1 to a taxonomy code, and an
HTTP status via `WP_Error::add_data(['status'=>N])`. Where Elementor's own REST already returns a
slug, reuse it and map:

| Elementor / WP source slug | taxonomy code |
|---|---|
| `global_classes_limit_exceeded` (`global-classes-rest-api.php:336`) | `BUDGET_EXCEEDED` |
| `invalid_order` (`global-classes-rest-api.php:369`) | `INVALID_ORDER` |
| `DUPLICATED_LABEL` (`global-classes-rest-api.php:384`) | `DUPLICATED_LABEL` |
| `rest_forbidden` / cap check fail | `CAPABILITY_MISSING` or `NOT_EDITABLE` |
| caught `\Exception` "Settings validation failed." | `ATOMIC_SETTINGS_INVALID` |
| caught `\Exception` "Styles validation failed for style …" | `ATOMIC_STYLES_INVALID` |

The plugin NEVER leaks the raw throw message as a `code`; it catches the `\Exception`, classifies, and
puts the appended parser errors in `meta.parser_errors` + `message`.

## 5. TS server mapping rules (server core contract)

1. Tool-argument Zod failures → throw at the protocol layer → `-32602` (`SCHEMA_INVALID_PARAMS`).
2. Any taxonomy code with `surface:"isError"` → return a tool result `{isError:true, content:[text]}`
   where text = `message` + compact `meta`; attach the full `McpErrorPayload` as structured content.
3. `retryable:true` codes → the TS client layer (`wp/client.ts`) MAY auto-retry with backoff for
   transient ones (`RATE_LIMITED`, `UPSTREAM_ERROR`, `CSS_PRIME_FAILED`) but NEVER auto-retries
   concurrency codes (`LOCK_HELD`, `AUTOSAVE_CONFLICT`, `CONCURRENCY_STALE_HASH`, `WATERMARK_STALE`) —
   those require an agent decision (re-read / `force`).
4. Soft codes (`DUPLICATED_LABEL`, `HTML_V3_STRIPPED`, `IDEMPOTENT_REPLAY`) are surfaced as `isError`
   **only when they change semantics the agent must act on**; otherwise they ride in the diff/report.
5. Destructive ops gate behind `elicitation/create` confirm; declining → return a clean
   non-error result (a user decision, not an error).

## 6. Frozen code list (for contract_summary)

`VALIDATION_FAILED`, `SCHEMA_INVALID_PARAMS`, `ATOMIC_SETTINGS_INVALID`, `ATOMIC_STYLES_INVALID`,
`UNKNOWN_WIDGET_TYPE`, `DUPLICATE_ELEMENT_ID`, `LOCAL_STYLE_UNLINKED`, `IMAGE_SRC_XOR_VIOLATION`,
`HTML_V3_STRIPPED`, `SETTINGS_INVALID`, `LOCK_HELD`, `AUTOSAVE_CONFLICT`, `CONCURRENCY_STALE_HASH`,
`IDEMPOTENT_REPLAY`, `BUDGET_EXCEEDED`, `DUPLICATED_LABEL`, `INVALID_ORDER`, `WATERMARK_STALE`,
`CAPABILITY_MISSING`, `EXPERIMENT_INACTIVE`, `AUTH_FAILED`, `PRO_REQUIRED`, `WOO_CONTEXT_INVALID`,
`NOT_FOUND`, `NOT_EDITABLE`, `CSS_PRIME_FAILED`, `RENDER_FAILED`, `IMPORT_REMAP_FAILED`,
`RATE_LIMITED`, `UPSTREAM_ERROR`, `INTERNAL_ERROR`.
(31 codes — `SETTINGS_INVALID` + `RENDER_FAILED` added by contract 18 §7-AI S1/S2; append-only.)
