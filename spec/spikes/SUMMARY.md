# Wave-1 Spike Summary — Elementor MCP

**Target:** Plan B docker-compose live stack — `http://localhost:8899`, Elementor 4.1.1 + Pro 4.1.0, V4 experiments (`e_atomic_elements`, `e_classes`, `e_variables`) ACTIVE. App-Password Basic auth verified.
**Date:** 2026-06-07
**Spikes run:** 7 (WP-S01, S02, S03, S04, S05, S06, S07). **All PASS.**

Per-spike detail lives in `WP-S0*-findings.md` / `S03-html-native-coverage-baseline.md` in this directory. Reusable: `fixtures/s01-atomic-hero.json`, `fixtures/s02-atomic-block.json`, `fixtures/sections/0{1..5}-*` + `fixtures/sections/corpus.manifest.json`, `scripts/s01-assert-css.mjs`, `scripts/s02-assert-roundtrip.mjs`, `scripts/s03-measure-coverage.mjs`.

---

## 1. Verdict table

| Spike | Question (abbrev.) | Verdict | Confirms / Corrects | One-line finding |
|---|---|---|---|---|
| **WP-S01** | Does headless `Document::save()` of a V4 atomic tree emit front-end CSS, and which prime approach works? | **PASS** | Confirms core; corrects prime mechanics | Headless save emits ZERO atomic CSS (residual confirmed); both primes PASS — **Approach B (in-process `do_action`) is the recommended default**. |
| **WP-S02** | Does template save process atomic elements + register class relations, and do styles/relations remap on insert? | **PASS** | Confirms core; corrects where merge happens | `save_item`/POST re-IDs elements **and** local-style ids + registers relations like editor save; global-class **merge happens at INSERT** (`get_data` → `process_global_styles`), not on save; image sideload only on file-import. |
| **WP-S03** | What native-prop coverage does HTML→native achieve on real marketing sections; per-property fallback rate? | **PASS** | **CORRECTS** (replaces hardcoded 85%) | Honest band, NOT a single number: REALISTIC **76.8–90.5% per section, corpus 84.8%** native on CLEAN fixtures (upper bound); messy exported HTML ~60–75%. Tail is 100% `transition`/`transform`/`gradient`/`filter`/`text-clip`/`list-style`; off-enum `font-weight`/`align-items`/`display:table` FALL; `grid repeat()/auto-fit-minmax`, `box-shadow`/`transform`/`filter` (correctly decomposed) STICK. Auto-commit floor **60%**, read from `corpus.manifest.json` (never literal 85%). Trees pass dry_run. |
| **WP-S04** | Does `Document::save(['settings'])` deep-merge or replace page settings? | **PASS** | **CORRECTS** | `save()`/`save_settings()` **REPLACE** wholesale (top + nested); only `update_settings()` deep-merges. Bare `save(['settings'=>$patch])` wipes unrelated settings; `{}` deletes the meta. |
| **WP-S05** | Does admin app-pw user have `UPDATE_CLASS`; global-classes PUT non-403; is the grant needed here? | **PASS** | **CORRECTS** (FQCN/path + cap names) | Admin HAS the cap (PUT reaches business validation, not 403); grant defensive, not required here. Cap class is `Modules\GlobalClasses\Database\Migrations\Add_Capabilities`, NOT `Utils\Add_Capabilities`; no `create_class`/`delete_class` caps. |
| **WP-S06** | Does App-Password Basic auth work over plain HTTP; is a local-env filter needed when availability is false? | **PASS** | **CORRECTS** | Availability and auth are **decoupled** — Basic auth works over plain HTTP with NO filter. Filter only needed to CREATE app-pw via UI on non-SSL. Plain permalinks → `/wp-json/` returns HTML homepage; use `?rest_route=`. |
| **WP-S07** | Does CSS flush work programmatically; how reliable? | **PASS** | **CORRECTS** | Flush reliable **only as the uid owning CSS files (uid 33 / Apache)**. wpcli sidecar (uid 82) clears DB meta but FAILS to unlink files and STILL reports Success. Reliable = in-process `clear_cache()` or `DELETE elementor/v1/cache`. |

---

## 2. SPEC CORRECTIONS (apply to RESEARCH.md / SUPPLEMENT.md / contracts)

### C1 — S01: prime-css mechanics under-specified (RESEARCH.md §7.4)
1. Approach A `wp_remote_get(home_url())`/`get_wp_preview_url()` is NOT reliable (cURL 7 on host/port/proxy mismatch). Robust loopback = `GET http://127.0.0.1:<port>/?page_id=<ID>` + explicit `Host:<host>` + `redirection:0`. **Default to Approach B (in-process `do_action`, no network).**
2. A prime is a SILENT no-op unless atomic cache-validity is invalidated first — `CSS_Files_Manager::get()` returns null without regenerating when cache is "valid" but file missing. MUST `do_action('elementor/atomic-widgets/styles/clear',[local|global|base])` before dispatch. Distinct `CSS_PRIME_FAILED` trap not in §7.4.
3. CSS dir owned by web-server uid (33). CLI/cron prime as a different uid silently writes nothing — prime MUST run as the web-server user (REST handler does).
4. File naming: `local-<id>-frontend-desktop.css`, `global-<id>-frontend-desktop.css`, `base-desktop.css` (frontend=published / preview=draft; non-desktop adds `-<bp>` + `@media`).
   Sequence: `wp_set_current_user` → `styles/clear [local]/[global]/[base]` → `post/render $id` → `after_enqueue_post_styles` → re-read files, assert non-empty + selector present else `CSS_PRIME_FAILED`. Global/kit/class writes: `files_manager->clear_cache()` first.
   **WPs:** WP-P04, WP-P05, WP-P06, WP-Q06, WP-H11, §6 PERSIST.

### C2 — S02: where the global-class merge happens (RESEARCH.md §5.7, §10 OQ#8)
`save_item`/POST templates does NOT merge classes or run `on_import`. It re-IDs elements **and dependent local-style ids** (local-style ids NOT stable across save), persists via `Document::save`, auto-registers relations. Merge happens at INSERT: `get_data()` (attaches `global_classes` snapshot) → `process_global_styles()`/`process_content`. Image sideload only on FILE import (`prepare_import_template_data`). `match_site` reuses by LABEL (no dup); `keep_create` mints `g-` class + remaps; >MAX_ITEMS(1000) flatten to local (report `flattened_classes_count`). Deleting a kit class fires `Global_Classes_Cleanup` rewriting ALL docs; `get_data` prunes orphan refs.
`templates.insert_into_page` MUST do `get_data` → `process_global_styles({content,global_classes,import_mode=match_site})` → `Document::save`, carrying the snapshot. **WPs:** WP-P12, WP-H11, WP-Q01; failures → `IMPORT_REMAP_FAILED`.

### C3 — S04: settings merge-vs-replace (RESEARCH.md §5.2)
"Merged" is true ONLY for `Document::update_settings()` (deep `array_replace_recursive`). Default `save(['settings'=>...])`/`save_settings()` REPLACES `_elementor_page_settings` wholesale (top + nested) via `update_metadata`. Bare `save(['settings'=>$patch])` silently wipes unrelated settings; PUT `{}` deletes the meta (`delete_metadata`). Special settings (template/post_status/post_title) stripped before write; `array_replace_recursive` does NOT element-merge numerically-indexed repeaters (stale trailing rows). `page.update_settings` MUST use `update_settings($patch)`. Test must `wp_set_current_user(admin)` or save no-ops. **WPs:** WP-P06, WP-F06.

### C4 — S05: capability FQCN/path + cap names (RESEARCH.md §8; error-taxonomy `CAPABILITY_MISSING`)
1. Cap class = `Elementor\Modules\GlobalClasses\Database\Migrations\Add_Capabilities` at `modules/global-classes/database/migrations/add-capabilities.php` (const line 8, admin-only grant line 14, `add_cap` line 24) — NOT `Utils\Add_Capabilities` (would fatal). Use literal `elementor_global_classes_update_class`.
2. Companion caps: `elementor_global_classes_remove_class`, `elementor_global_classes_apply_class` (admin/editor/author/contributor/shop_manager). NO `create_class`/`delete_class`. Only `UPDATE_CLASS` is admin-only and gates ALL global-class writes via the single PUT.
PUT `permission_callback = current_user_can(Add_Capabilities::UPDATE_CLASS)` at `global-classes-rest-api.php:154`; missing → 403 `rest_forbidden`; GET reads remain. **WPs:** WP-P01 (grant defensive, not required here), WP-F05, WP-P08, WP-P02.

### C5 — S06: app-pw availability decoupled from auth; plain-permalink REST gotcha (RESEARCH.md §8; `AUTH_FAILED`)
1. Availability (false here) and authentication decoupled. WP 7.0 `wp_authenticate_application_password()` has no `is_ssl()`/availability gate — Basic auth works over plain HTTP with NO filter. Filter only for app-pw CREATION via UI on non-SSL; `wp_get_environment_type()==='local'`-guarded (inert here, env=production); production keeps HTTPS.
2. Plain permalinks → `/wp-json/...` 301s to HTML homepage returning 200 text/html (silent false positive). Client MUST use `?rest_route=` (or pretty permalinks) and validate `Content-Type: application/json`; prefer `rest_url()`.
3. Basic auth does NOT authenticate admin-ajax (returns `0`/400) — custom REST save route justified.
**WPs:** WP-P01 (filter optional, `is_local`-guarded), WP-P02 (`?rest_route=` + JSON check; `AUTH_FAILED` 401 `rest_not_logged_in` / no-cap 401/403 `rest_forbidden`), WP-F02.

### C6 — S07: CSS flush reliability uid-dependent + silently lies on failure (RESEARCH.md §7.4/§7.2)
Flush reliable ONLY as the uid owning `uploads/elementor/css/*` (33/Apache). Traps: (1) `clear_cache()` reports Success even when `unlink()` fails (no return check, `manager.php:111-113`); (2) wpcli sidecar (uid 82) cannot delete Apache-owned files — clears DB meta only, leaves stale CSS; `flush-css --regenerate` from sidecar fails unlink AND regen yet prints Success. `clear_cache()` does NOT touch global-class design data. Implement auto-flush as in-process `\Elementor\Plugin::$instance->files_manager->clear_cache()` (optionally `->generate_css()`), or reuse `DELETE elementor/v1/cache`. Assert `glob(uploads/elementor/css/*)` empty — never trust the success string. Multisite `--network` unverified. **WPs:** WP-P05, WP-P13, WP-P08/P09.

---

## 3. GO / NO-GO for the MVP write surface

**VERDICT: GO.**

**Did S01 prove atomic CSS renders after a headless save?** Yes, conditionally and exactly as the spec's core assumption predicted. Headless `Document::save(['elements'=>...])` writes `_elementor_data` (local style id + global class ref present) and global-class relations meta, but emits ZERO front-end atomic CSS (residual confirmed; reproduced posts 10 & 12). After priming, atomic CSS DOES render: verified on-disk bytes (e.g. `local-10-frontend-desktop.css = .elementor .e-s01head1-local{font-size:48px;color:rgb(0,128,255);}`), public URL HTTP 200 links all three CSS files, markup carries expected classes, harness 8/8 PASS.

**Which prime-css approach?** **Approach B (in-process programmatic `do_action` dispatch) as primary**, inside the authed REST request. Both A and B PASS, but A's `wp_remote_get(home_url())` is fragile across host/port/proxy mismatches; B has no network dependency. Keep loopback (`127.0.0.1`+`Host`+`redirection:0`) as optional cross-check. Two mandatory gates (cache-validity `styles/clear`; run as file-owner uid) must be handled or prime is a silent no-op → `CSS_PRIME_FAILED`.

**Other MVP gates — all OPEN:** S2 unblocks templates.save/insert/import; S4 unblocks page.update_settings (use `update_settings()`); S5 unblocks design-system class writes (cap present, grant defensive); S6 unblocks REST auth for all proxied tools (`?rest_route=`); S7 unblocks single-site flush (in-process, assert dir empty). No blocking NO-GO.

---

## 4. Newly-discovered risks

| # | Risk | Source | Mitigation / WP |
|---|---|---|---|
| R1 | Silent prime no-op — `CSS_Files_Manager::get()` returns null without regenerating when cache "valid" but file missing. | S01 | `styles/clear` before dispatch; assert non-empty → `CSS_PRIME_FAILED`. P04/P05. |
| R2 | uid-mismatch silent flush/prime failure — non-owner uid writes/deletes nothing yet reports Success. | S07,S01 | Run in-process (web-server uid)/REST; assert filesystem, not success string. P05/P13. |
| R3 | Settings data-loss — bare `save(['settings'=>$patch])` wipes unrelated; PUT `{}` deletes meta. | S04 | Route via `update_settings()`; regression test. P06/F06. |
| R4 | Plain-permalink REST false positive — `/wp-json/` returns 200 text/html homepage. | S06 | Client uses `?rest_route=` + `Content-Type: application/json` check. P02/F02. |
| R5 | Local-style ids NOT stable across save/round-trip. | S02 | Never cache/assume stable local-style ids; re-read after save. P04/P12/Q01. |
| R6 | Kit-class deletion rewrites ALL documents (incl. templates); orphan refs pruned. | S02 | Treat as global mutation → full flush + re-prime dependents. P08/P12. |
| R7 | Spec FQCN `Utils\Add_Capabilities` would fatal (does not exist). | S05 | Use literal cap string + correct `Modules\...\Add_Capabilities`. P01/F05. |
| R8 | Atomic prop envelopes strictly typed — bare strings fail validator (`tag/title invalid_value`, `class_name_too_short`). | S01,S02 | Freeze typed envelopes in fixtures; pre-validate → structured errors. F03/Q01/P03. |
| R9 | First cold render writes AND links CSS — only headless/CDN/export consumers hit unstyled residual (hard to reproduce manually). | S01 | Document residual; rely on explicit prime, not first-visit. P04. |
| R10 | Multisite `--network` flush unverified; inherits uid + silent-success caveats. | S07 | Probe separately if in scope; per-subsite in-process `clear_cache()` under `switch_to_blog()`. Out of MVP. |

> **R1/R2 status (2026-06-10): mitigations shipped in the companion plugin.**
> `Css_Primer::dispatch_programmatic()` fires `styles/clear` (local/global/base)
> before dispatch, runs **in-process inside the authed REST request** (web-server
> uid), and verification asserts on-disk file bytes + every expected selector,
> raising `CSS_PRIME_FAILED` otherwise — the success string is never trusted.
> `Cache_Service::flush_all()` glob-asserts `uploads/elementor/css/*` is empty
> after `clear_cache()` and surfaces `flushed:false` (op-logged as `stale`)
> instead of reporting success; no code path shells out to the CLI sidecar.
> The trap remains for **out-of-band** ops: never run `wp elementor flush-css`
> from the wpcli sidecar (uid mismatch → silent no-op) — use the plugin's
> cache-flush REST route instead.
