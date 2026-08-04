---
id: WP-P05
title: CSS_Primer (V4 atomic CSS priming) + Cache_Service (V3 Post_CSS + full flush)
layer: php
phase: MVP
status: planned
depends_on: [WP-P01, WP-P02, WP-S01]
files_owned:
  - plugin/elementor-ultra-mcp/includes/core/class-css-primer.php
  - plugin/elementor-ultra-mcp/includes/core/class-cache-service.php
contract_refs:
  - spec/contracts/10-rest-api.md §0.10 (atomic CSS priming rule), §0.12 (cache side effects), §2.7 (prime-css route), §9 (cache routes)
  - spec/contracts/11-authoring-contract.md §10 (CSS priming invariants)
  - spec/contracts/12-error-taxonomy.md §3.5 (CSS_PRIME_FAILED)
  - spec/contracts/15-engineering-standards.md §3.9 (atomic CSS priming), §6 (S1 spike-gate)
estimate: M
---

## Summary

The mandatory atomic-CSS priming step plus the V3/full cache services. `Css_Primer` makes V4 atomic styles actually render after a headless save (which alone produces no atomic CSS — the LOCKED decision and spike S1), using the approach S1 proved reliable (loopback render and/or programmatic enqueue). `Cache_Service` wraps V3 `Post_CSS` regen and the full `files_manager->clear_cache()` flush used by document and design-system writes. These two services are consumed by `Document_Writer` (WP-P04), the documents controller (WP-P06), and the cache controller (WP-P13).

## Interface / Contract

- `\Elementor\Ultra\Core\Css_Primer`:
  - `prime( int $post_id, string $approach = 'auto', array $breakpoints = [] ): array` — returns Contract 10 §2.7 `data`:
    ```
    { id, css_primed:bool, approach_used:"loopback"|"programmatic", css_files:[..], css_bytes:int, warnings:[..] }
    ```
    `css_primed:false` with `warnings[]` is a SUCCESS (200-with-warning), NOT an error (Contract 10 §2.7). A hard internal failure returns a `WP_Error('CSS_PRIME_FAILED', ...)` (Contract 12 §3.5) only when priming could not even attempt.
  - `is_atomic_document( int $post_id ): bool` — true when the tree contains atomic `e-*` nodes (priming only matters for atomic).
  - approaches: `loopback` = `wp_remote_get( get_wp_preview_url($id) )` to trigger `elementor/frontend/after_enqueue_post_styles` + `elementor/atomic-widgets/styles/register`; `programmatic` = dispatch `elementor/post/render` then the enqueue flow; `auto` = use the S1-proven approach (recorded by WP-S01).
- `\Elementor\Ultra\Core\Cache_Service`:
  - `regen_post( int $post_id ): bool` — V3 `Post_CSS::create($post_id)->update()` (no-op for atomic pages, Contract 11 §10).
  - `regen_global( bool $network = false ): array{ regenerated:int }` — global regen batched 100/run (Contract 10 §9); `network:true` mirrors `wp elementor flush-css --network` (spike S7).
  - `flush_all( bool $network = false ): bool` — `Plugin::$instance->files_manager->clear_cache()` (Contract 10 §0.12, §9; `core/files/manager.php:107-117`).
  - `flush_post( int $post_id ): void` — delete `_elementor_css` + `_elementor_element_cache` + `Post_CSS::create($id)->delete()` (used after raw restores / by rollback).
  - `flush_design_system(): void` — the full flush every design-system write triggers (Contract 10 §0.12); thin alias over `flush_all(false)` plus kit cache.

## Dependencies & Inputs

- WP-S01 (SPIKE, mandatory gate): the prime-css approach. This WP is BLOCKED from merge until S1 PASS records which approach (`loopback`|`programmatic`) works (Contract 15 §6 S1 row; LOCKED decision: "V4 atomic CSS does NOT render on a headless save → prime-css step is MANDATORY (depends on spike WP-S01)"). `auto` reads the recorded approach.
- WP-P01 (`Guards`), WP-P02 (`Error` factory for `CSS_PRIME_FAILED`).
- Elementor APIs (cite `path:line`):
  - `modules/atomic-widgets/styles/atomic-styles-manager.php:47-150` — proves headless `Document::save` does NOT emit atomic CSS; atomic styles register on frontend hooks `elementor/frontend/after_enqueue_post_styles` and `elementor/atomic-widgets/styles/register`.
  - `Elementor\Core\Files\CSS\Post as Post_CSS` → `Post_CSS::create($id)->update()/->delete()` (V3 path).
  - `Plugin::$instance->files_manager->clear_cache()` `core/files/manager.php:107-117`.
  - `get_wp_preview_url( $post_id )` (Document) / `get_permalink` for the loopback URL.
- Contract 10 §0.10 (priming RULE — any route persisting an atomic tree returns `css_primed:false`,`prime_required:true` until primed), §2.7 (route payload), §0.12 (cache side effects), §9 (cache routes).
- Contract 11 §10 (`Post_CSS::create($id)->update()` no-ops for atomic; atomic renders only on frontend hooks).

## Detailed Requirements

1. **Loopback priming** (Contract 10 §2.7, S1): `prime($id,'loopback')` issues a server-side `wp_remote_get` to the post's preview/permalink URL with a short timeout, forwarding auth where needed (for draft preview, append the `post_preview_{id}` nonce or use an authenticated loopback). The frontend render fires the atomic style hooks which write the per-breakpoint CSS files. After the request, enumerate the generated CSS files and report `css_files`, `css_bytes`.
2. **Programmatic priming** (S1 alternative): dispatch `do_action('elementor/post/render', $id)` (or instantiate the document frontend render) and then run the enqueue flow so `atomic-styles-manager` registers + writes styles. Use whichever S1 recorded; `auto` picks it.
3. **Breakpoint scoping**: when `breakpoints[]` is supplied, restrict priming/verification to those breakpoint CSS files (Contract 10 §2.7). When empty, prime all active breakpoints (read from WP-P07 `schema/breakpoints` data or `Breakpoints_Manager`).
4. **Confirmation + warnings** (Contract 10 §2.7): after priming, verify the expected CSS files exist and are non-empty. If they cannot be confirmed (the residual "unstyled until first real hit" case, RESEARCH.md §7.4), return `css_primed:false` with a clear `warnings[]` entry — this is a 200, not an error. Only a total inability to attempt priming (e.g. document missing) yields `CSS_PRIME_FAILED` (Contract 12 §3.5, retryable).
5. **`is_atomic_document`**: read `_elementor_data`, detect any `e-*` elType or any node with a `styles` map; only atomic docs need priming (Contract 11 §10).
6. **V3 regen** (Contract 10 §9): `regen_post` calls `Post_CSS::create($id)->update()`. `regen_global` iterates Elementor-built posts in batches of 100 calling `regen_post` (Contract 10 §9 "batches 100/run").
7. **Full flush** (Contract 10 §0.12, §9): `flush_all` calls `Plugin::$instance->files_manager->clear_cache()`. `flush_design_system` is the flush invoked after EVERY design-system write (classes/variables/colors/fonts/defaults/sync) — WP-P08/P09 call it; ensure it also clears the kit CSS (`kit.php:105`).
8. **Multisite awareness** (spike S7): `network:true` on `regen_global`/`flush_all` fans out across sites via `get_sites()` + `switch_to_blog()`; this is the "multisite fan-out polish" gated by S7 — implement behind a guard and a clear warning if S7 has not confirmed reliability (degrade to current-site flush with a `warnings[]` note).
9. **No-op safety**: priming an all-V3 document returns `css_primed:true` (nothing to prime is success) and `prime_required:false` semantics are handled by the caller; `Css_Primer` just reports it did nothing.

## Implementation Notes

- The S1 spike note (recorded by WP-S01) is the contract for `auto`. Read it from a constant/option the spike WP sets, or hardcode the approach S1 chose with a `path:line` comment citing the spike artifact. Do not guess — this WP is spike-gated.
- Loopback auth: for a published page, an anonymous `wp_remote_get` is enough. For a draft, either prime against a per-user autosave preview URL (with the `post_preview_{id}` nonce) or temporarily render with `is_preview` — coordinate with WP-P06's `want_preview`/`prime-css` route which holds the request context.
- `Post_CSS::create($id)->update()` is genuinely a no-op for atomic content (Contract 11 §10) — do not rely on it for atomic; that is the entire reason this WP exists.
- `files_manager->clear_cache()` is broad (clears all Elementor CSS). Design-system writes intentionally use the full flush (Contract 10 §0.12) — do not try to be clever with partial invalidation for design writes.
- Keep `prime` resilient to slow loopbacks: bounded timeout, capture `warnings` rather than throwing on timeout (it becomes `css_primed:false` + warning).

## Acceptance Criteria

- [ ] After `Document_Writer::save` of an atomic tree followed by `Css_Primer::prime`, the generated per-breakpoint CSS contains the tree's local-style + global-class selector rules (the Contract 14 §3-step-3 render assertion; S1-gated — runs as `xfail`/`skip` until S1 PASS, then must pass).
- [ ] `prime` returns `{css_primed, approach_used, css_files, css_bytes, warnings}` matching Contract 10 §2.7.
- [ ] A priming attempt that cannot confirm CSS returns `css_primed:false` + a `warnings[]` entry at HTTP 200 (NOT an error).
- [ ] `is_atomic_document` returns true for a tree with `e-*`/`styles` and false for an all-classic tree.
- [ ] `regen_post` runs `Post_CSS::create($id)->update()`; `flush_all` runs `files_manager->clear_cache()`.
- [ ] `regen_global` batches at 100 per run and reports the count.
- [ ] `network:true` either fans out across sites (if S7 confirmed) or degrades to current-site with a documented warning.
- [ ] PHPCS clean.

## Tests Required

- PHPUnit (wp-env, S1-gated): `test_prime_atomic_emits_css_with_rules` (the render assertion — `xfail`/`skip` reason string until S1 PASS); `test_prime_v3_is_noop_success`; `test_prime_unconfirmed_returns_warning_not_error`; `test_flush_all_clears_cache`; `test_regen_global_batches`.
- Unit: `test_is_atomic_document_detection`.
- Consumes `trees/v4/valid/**` fixtures (the same trees the render assertion checks).

## Parallelization Notes

- Wave-1 core service, but SPIKE-GATED on WP-S01 (cannot merge until S1 PASS). Parallel-safe to BUILD alongside WP-P03 and WP-P04 (disjoint files); WP-P04 consumes `Css_Primer`/`Cache_Service` behind a `class_exists` guard so it does not block on this WP.
- Every atomic-CSS-affecting WP across the codebase (WP-P06 documents save/prime-css, WP-H## convert.html_to_page, WP-R## Pro create routes) depends on this WP + WP-S01 per the universal rule; they call `Css_Primer` via the frozen interface.
- WP-P13 (cache controller) and WP-P14/rollback consume `Cache_Service`. Disjoint files from all of them.

## Spike-Verified Corrections (Wave 1)

- **[S01]** The prime MUST default to Approach B (in-process `do_action` dispatch, no network), executed inside the authenticated REST request. The exact sequence the primer MUST run, per primed post id:
  1. `wp_set_current_user(<capable id>)` (already the App-Password user in REST);
  2. `do_action('elementor/atomic-widgets/styles/clear', ['local'])`, `[...'global']`, `[...'base']` (base only if base styles changed);
  3. `do_action('elementor/post/render', $post_id)` (pushes the id into `Atomic_Styles_Manager`);
  4. `do_action('elementor/frontend/after_enqueue_post_styles')` (runs `enqueue_styles()` → fires `elementor/atomic-widgets/styles/register` → emits files);
  5. re-read the per-breakpoint files and assert non-empty + expected selector present, else raise `CSS_PRIME_FAILED`.
- **[S01/R1]** The primer MUST invalidate atomic cache-validity (the `styles/clear` calls above, or `Plugin::$instance->files_manager->clear_cache()`) BEFORE dispatch. `CSS_Files_Manager::get()` returns null WITHOUT regenerating when `Cache_Validity::is_valid()` is TRUE even if the file is missing on disk (validity persists in WP options `elementor_atomic_cache_validity__{local,global,base}` across requests/CLI). Skipping this makes the prime a silent no-op (`CSS_PRIME_FAILED` "valid-cache-but-missing-file" trap).
- **[S01]** File naming the primer MUST re-read and assert (published page = `frontend`; draft/preview = `preview`; non-desktop breakpoints append `-<bp>` + `@media` wrapper): local `uploads/elementor/css/local-<postId>-frontend-desktop.css` → `.elementor .<localStyleId>{...}`; global `global-<postId>-frontend-desktop.css` → `.elementor .<globalClassId>{...}`; base `base-desktop.css`. Assert non-empty AND selector present; an empty CSS file is only a real failure when the post actually has atomic styles/classes.
- **[S01/S07/R2]** Flush AND prime MUST run as the uid that owns `uploads/elementor/css/*` (web-server uid 33 / Apache). A different uid (e.g. a CLI sidecar at uid 82) silently writes/deletes nothing while still appearing to succeed. The in-process REST handler satisfies this; do NOT prime/flush from a differently-imaged CLI container.
- **[S01]** Approach A (loopback HTTP) is only an OPTIONAL cross-check. `wp_remote_get(home_url()/get_permalink())` is NOT reliable (cURL error 7 on host/port/proxy mismatch). If used, the robust recipe is `GET http://127.0.0.1:<listen-port>/?page_id=<id>` with an explicit `Host: <site host>` header and `redirection => 0`.
- **[S07/C6/R2]** For global/kit/class writes the Cache_Service MUST do a full flush in-process via `\Elementor\Plugin::$instance->files_manager->clear_cache()` (optionally `->generate_css()`), or the reused `DELETE elementor/v1/cache` route, BEFORE re-priming dependents. `clear_cache()` does NOT check `unlink()` return and reports success even when deletion FAILS (`wp-content/plugins/elementor/core/files/manager.php:111-113`). The service MUST assert `glob(uploads/elementor/css/*)` is empty after flush — NEVER trust the success string. In tests on plain-permalink sites hit the route via `?rest_route=`.
