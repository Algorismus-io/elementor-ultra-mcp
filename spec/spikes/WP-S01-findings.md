# WP-S01 — Headless atomic save + CSS priming (FINDINGS)

**Spike:** WP-S01 (the load-bearing spike). **Date:** 2026-06-07.
**Target:** Plan B docker-compose stack — WordPress at http://localhost:8899, Elementor 4.1.1 + Pro 4.1.0, experiments `e_atomic_elements` + `e_classes` + `e_variables` ACTIVE.

## VERDICT

**PASS.** A headless `Document::save(['elements'=>$tree,'settings'=>[]])` of a V4 atomic tree writes `_elementor_data` correctly and validates atomic props, but — as the spec assumed — **does NOT emit any front-end atomic CSS on its own**. The per-breakpoint atomic CSS files are produced only by the front-end `enqueue_styles()` flow. **BOTH prime approaches from RESEARCH.md §7.4 work** (with caveats); `do_action('elementor/atomic-widgets/styles/register')` **DOES fire outside a real HTTP render context**.

- `confirms_spec = true` for the core assumption (headless save → no atomic CSS; prime required).
- Important **corrections / new caveats** for WP-P04 are listed at the bottom — the spec under-specified the loopback host-resolution problem and the cache-validity gating, and both prime approaches have hard failure modes that WP-P04 MUST handle.

## Fixtures & scripts (artifacts)

- `spec/spikes/fixtures/s01-atomic-hero.json` — canonical atomic hero (frozen authoring shape; reusable by WP-Q01/WP-Q06).
- `spec/spikes/scripts/s01-save-atomic-tree.php` — headless save (creates global class, builds tree, saves, proves residual).
- `spec/spikes/scripts/s01-prime-approach-a-loopback.php` — Approach A (server-side loopback HTTP GET).
- `spec/spikes/scripts/s01-prime-approach-b-programmatic.php` — Approach B (programmatic `do_action` dispatch, no HTTP).
- `spec/spikes/scripts/s01-assert-css.mjs` — reusable PASS/FAIL assertion harness (reads CSS from the container FS).
- `spec/spikes/scripts/s01-state.json` — emitted state (post_id, ids, css_dir) consumed by downstream scripts/harness.

## The authoring shape that actually validates (corrected)

The first save attempt FAILED validation: `Settings validation failed. tag: invalid_value, title: invalid_value`. Atomic props are typed envelopes whose `$$type` MUST equal the prop's `get_key()` (`has-transformable-validation.php`). Verified shapes:

- `classes` → `{ "$$type": "classes", "value": ["<id>", ...] }`
- heading `tag` → `{ "$$type": "string", "value": "h1" }`   (NOT a bare `"h1"`)
- heading `title` / button `text` → `{ "$$type": "html-v3", "value": { "content": { "$$type": "string", "value": "..." }, "children": [] } }`
- A LOCAL style lives in the element's `styles` map keyed by its style id; it is referenced by putting that id into `settings.classes.value`. Shape:
  `{ id, type:"class", label, variants:[ { meta:{breakpoint,state}, props:{ color:{"$$type":"color","value":"rgb(...)"}, "font-size":{"$$type":"size","value":{"unit":"px","size":48}} } } ] }`
- A GLOBAL class is created via `Global_Classes_Repository::make()->apply_changes($touched, $changes, $order)` (diff API) and referenced by putting its id into `settings.classes.value`. Selector emitted is `.elementor .<id>`.

## STEP 1 — Headless save (residual proof)

Command:
```
docker compose -p elementor-mcp -f tools/wp-stack/docker-compose.yml run --rm \
  -v <repo>/spec/spikes/scripts:/spikes wpcli wp eval-file /spikes/s01-save-atomic-tree.php
```
Raw evidence (post id 10):
```
DOCUMENT_SAVE: save() returned TRUE
_elementor_data_LEN: 1141
_elementor_data_HAS_LOCAL_STYLE: YES
_elementor_data_HAS_GLOBAL_CLASS_REF: YES
RELATIONS_used_global_class(frontend): [ e-s01head1-local, s01hero ]   # auto-linked on save
CSS_FILES_AFTER_SAVE (expect none): []                                 # <-- RESIDUAL: no atomic CSS
```
Notes:
- `Document::save()` first guards on `is_editable_by_current_user()`; under WP-CLI (user 0) it silently returns FALSE and writes nothing. **You MUST `wp_set_current_user(<capable user>)` before a headless save.** (WP-P04: the REST controller runs as the App-Password user, so this is satisfied there — but any CLI path must set the user.)
- The atomic validator is authoritative: invalid prop envelopes throw `\Exception('Settings validation failed. ...')` from `Atomic_Widget_Base::parse_atomic_settings` during `get_data_for_save()`. WP-P04/dry-run should surface these as structured `isError` text.
- `elementor/document/after_save` auto-populates the global-class relations meta (`_elementor_used_global_class[ _preview ]`) from the saved tree — no separate "attach" call is needed for the relations index.

## STEP 1b — HTTP-level residual nuance

A cold front-end GET (`curl http://localhost:8899/?page_id=10`) AFTER deleting CSS + invalidating cache:
```
HTTP 200 bytes=75243
links in FIRST response: base-desktop.css, global-10-frontend-desktop.css, local-10-frontend-desktop.css
css dir immediately after first hit: [ base-desktop.css, global-10-frontend-desktop.css, local-10-frontend-desktop.css ]
```
**The first front-end render BOTH writes the files AND links them in the same response** — the very first visitor is not served unstyled. The "unstyled until primed" residual therefore only bites a consumer that reads/serves the page WITHOUT triggering a front-end render (e.g. an MCP that saves headless then reads CSS files, a CDN/edge cache that captured a pre-render state, or a "publish then export" flow). Mitigation = an explicit prime step right after the headless save.

## STEP 2 — Approach A (loopback) → PASS

Run from a clean residual. Evidence (run inside the wordpress container's PHP via wp-load):
```
RESIDUAL css files: []
A1 wp_remote_get(home_url = http://localhost:8899/?page_id=10):
   WP_ERROR: cURL error 7: Failed to connect to localhost port 8899
A2 wp_remote_get('http://127.0.0.1/?page_id=10', headers:{Host: localhost:8899}, redirection:0):
   HTTP 200 bytes=75243
AFTER_LOOPBACK css files: [ base-desktop.css, global-10-frontend-desktop.css, local-10-frontend-desktop.css ]
LOCAL CSS : .elementor .e-s01head1-local{font-size:48px;color:rgb(0, 128, 255);}
GLOBAL CSS: .elementor .s01hero{padding-block-start:24px;padding-block-end:24px;padding-inline-start:32px;padding-inline-end:32px;background-color:rgb(255, 0, 128);}
BASE CSS  : 5397 bytes
APPROACH_A VERDICT: PASS
```
**Critical loopback caveat (NOT in the spec):** `wp_remote_get(get_permalink()/home_url())` uses WP's `siteurl`/`home` (`http://localhost:8899`). In this stack the published host port (8899) is NOT the internal Apache listen port (80), so the canonical URL is unreachable from inside the WP container → cURL error 7. Hitting the internal listener with the wrong Host triggers a 301 redirect back to `siteurl` (still unreachable). The working recipe is **GET the loopback address (`127.0.0.1` on the listen port) with an explicit `Host: <site host>` header and `redirection => 0`.** In a typical production single-host deploy, `siteurl` resolves to the same server and the plain `wp_remote_get(home_url())` works; the 127.0.0.1+Host fallback is the robust path for split host/port and reverse-proxy setups. (`CSS_PRIME_FAILED` candidate condition.)

## STEP 3 — Approach B (programmatic, no HTTP) → PASS

In-process dispatch (no HTTP request):
```php
wp_set_current_user($adminId);
do_action('elementor/atomic-widgets/styles/clear', ['local']);   // invalidate atomic cache-validity + delete files
do_action('elementor/atomic-widgets/styles/clear', ['global']);
do_action('elementor/atomic-widgets/styles/clear', ['base']);
do_action('elementor/post/render', $post_id);                    // push post id into Atomic_Styles_Manager
do_action('elementor/frontend/after_enqueue_post_styles');       // run enqueue_styles() -> emit files
```
Evidence (run as www-data / uid 33 inside the wordpress container):
```
HOOKS registered (even in CLI): after_enqueue_post_styles, post/render, atomic-widgets/styles/register
AFTER programmatic dispatch css files: [ base-desktop.css, global-10-frontend-desktop.css, local-10-frontend-desktop.css ]
LOCAL CSS : .elementor .e-s01head1-local{font-size:48px;color:rgb(0, 128, 255);}
GLOBAL CSS: .elementor .s01hero{...background-color:rgb(255, 0, 128);}
APPROACH_B VERDICT: PASS
```
Instrumentation confirmed the mechanism end-to-end:
- `elementor/post/render` appends the post id to `Atomic_Styles_Manager::$post_ids`.
- `enqueue_styles()` (bound to `after_enqueue_post_styles`) fires `do_action('elementor/atomic-widgets/styles/register', $mgr, [10])` — **this DOES fire outside a real render context** — and the listeners register the per-post style callbacks (keys `base`, `local-10-frontend`, `global-10-frontend`).
- `Styles_Renderer::make($bp)->render($defs)` produced exactly `.elementor .e-s01head1-local{...}` in isolation, proving CSS generation is context-free.

### Two non-obvious gates that made Approach B "fail" until fixed (must be handled by WP-P04)

1. **Cache-validity gating.** `CSS_Files_Manager::get()` will NOT (re)write a file if `Cache_Validity::is_valid($breakpointPath)` is TRUE — even if the file is missing on disk (it returns null without regenerating). Atomic cache-validity is persisted in WP options (`elementor_atomic_cache_validity__{local,global,base,...}`) and survives across requests/CLI runs. So a prime MUST first invalidate (`do_action('elementor/atomic-widgets/styles/clear', ['local'|'global'|'base'])`, or `Plugin::$instance->files_manager->clear_cache()`) or the dispatch is a silent no-op. This is the `CSS_PRIME_FAILED` "valid cache but missing file" trap.
2. **Filesystem ownership.** The css dir `wp-content/uploads/elementor/css/` is owned by the WordPress PHP user (uid 33 in the `wordpress` container). The **wpcli container's `www-data` is uid 82** — it cannot write that dir (775), so a prime run from the wpcli container silently writes nothing AND `files_manager->clear_cache()` emits `unlink ... Permission denied`. The prime MUST run as the web-server user (which it does when it runs inside a REST request — the normal WP-P04 path). Any CLI-based prime must run as the correct uid.

## STEP 4 — Assertion harness + public-URL end-to-end

`node spec/spikes/scripts/s01-assert-css.mjs` → all checks PASS:
```
[PASS] local CSS file non-empty (68 bytes)
[PASS] local selector present (.e-s01head1-local)
[PASS] local declaration present (color/font-size)
[PASS] global CSS file non-empty (153 bytes)
[PASS] global selector present (.s01hero)
[PASS] global declaration present (background/padding)
[PASS] atomic base CSS present (5397 bytes)
[PASS] fonts/frontend enqueue on page (best-effort)
VERDICT: PASS
```
Public URL `curl http://localhost:8899/?page_id=10` (HTTP 200) links all three atomic CSS files and applies the classes to the markup:
```
<h1 data-interaction-id="s01head1" class="e-s01head1-local e-heading-base" ...>   # LOCAL style applied
<button class="s01hero e-button-base" ...>                                        # GLOBAL class applied
```
(Note: the `.css` files served over HTTP can transiently return an empty body due to proxy/304 caching; the on-disk bytes in the container are authoritative — the harness reads those via `docker compose exec ... cat`.)

## Per-breakpoint file naming (for WP-Q06 render-assertion targeting)

Handle = `implode('-', $path)` (`CSS_Files_Manager`/`Atomic_Styles_Manager::convert_path_to_handle`). For a published page rendered in frontend context, desktop breakpoint:
- LOCAL : `uploads/elementor/css/local-<postId>-frontend-desktop.css`  → `.elementor .<localStyleId>{...}`
- GLOBAL: `uploads/elementor/css/global-<postId>-frontend-desktop.css` → `.elementor .<globalClassId>{...}`
- BASE  : `uploads/elementor/css/base-desktop.css`
- Context segment is `frontend` for published posts, `preview` for drafts/preview (`Atomic_Widget_Styles::get_context`). Non-desktop breakpoints get a `-<breakpoint>` suffix and a `@media(...)` wrapper; breakpoints whose media is null are skipped.

## Spike-gate impact (15-engineering-standards.md §6)

**S1 is PASS with a recorded working approach.** Unblocks: WP-P04 (CssPrimer), `page.build`, `page.replace_tree`, `convert.html_to_page`, and the Contract 14 §3-step-3 render assertion (WP-Q06).

## CSS_PRIME_FAILED conditions WP-P04 MUST handle (12-error-taxonomy.md)

1. **Loopback unreachable** — `wp_remote_get(home_url())` returns `WP_Error` (cURL 7 / DNS / TLS) or a non-2xx. Recommended WP-P04 strategy: try `wp_remote_get(home_url())` first; on failure, fall back to **Approach B (in-process programmatic dispatch)** which has no network dependency — this is the more robust default for the companion plugin since it always runs inside the WP PHP process. Keep loopback (with the 127.0.0.1 + Host header + redirection:0 recipe) as a secondary verification.
2. **Stale-valid cache, missing file** — must invalidate atomic cache-validity (`styles/clear` for `local`/`global`/`base`, or `files_manager->clear_cache()` for global/kit writes) BEFORE dispatch, else the prime is a silent no-op.
3. **Filesystem not writable** — `CSS_Files_Manager::get()` returns null on `put_contents` failure (wrong owner / perms / read-only uploads). Detect by re-reading the expected per-breakpoint file after prime and asserting non-empty + selector present (exactly what `s01-assert-css.mjs` does); surface `CSS_PRIME_FAILED` with the path.
4. **Redirect loop / canonical host mismatch** — a loopback that follows a 301 to an unreachable `siteurl`. Use `redirection => 0` and the explicit Host header.
5. **Empty CSS legitimately** — if a style def yields empty CSS, `get()` returns null and writes nothing; that is NOT a failure. WP-P04 should only flag `CSS_PRIME_FAILED` when styles are expected (post has atomic styles/classes) but the files are absent/empty after prime.

## Recommended WP-P04 approach (recorded)

**Primary: Approach B (programmatic, in-process).** Sequence per primed post id, executed as part of the authenticated REST request (web-server user, satisfies both the editable-user and filesystem-owner gates):
```
wp_set_current_user(get_current_user_id());   // already the App-Password user in REST
do_action('elementor/atomic-widgets/styles/clear', ['local']);
do_action('elementor/atomic-widgets/styles/clear', ['global']);
do_action('elementor/atomic-widgets/styles/clear', ['base']);   // base only if base styles changed
do_action('elementor/post/render', $post_id);
do_action('elementor/frontend/after_enqueue_post_styles');
// then assert files exist + contain expected selectors; else CSS_PRIME_FAILED.
```
Rationale: no network dependency (immune to the loopback host-resolution problem), it fires `styles/register` correctly, and it runs as the right user/uid inside the REST handler. Keep Approach A (loopback with the 127.0.0.1+Host recipe) available as an optional cross-check / for environments where direct hook dispatch is undesirable. For global/kit changes, prefer `Plugin::$instance->files_manager->clear_cache()` (full flush) before the dispatch so every dependent page re-primes.
