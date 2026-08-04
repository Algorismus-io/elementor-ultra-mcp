# WP-S07 — CSS flush programmatic reliability (findings)

**Spike:** WP-S07 (adapted to the live single-site Plan B stack; the WP file is titled
"flush-css --network reliability on multisite", but the live target is **single-site**,
so per the focused guidance this run verifies: (a) `wp elementor flush-css` exists + runs,
(b) `--network` is multisite-only — noted, (c) `files_manager->clear_cache()` via PHP eval,
(d) that `wp-content/uploads/elementor/css/*` is actually cleared, and the reliability of each path.)

**Date:** 2026-06-07
**Target:** http://localhost:8899 — Elementor 4.1.1 + Pro 4.1.0, single-site.
**Verdict:** PASS (CSS flush works programmatically) — **but with a critical caveat that
corrects a hidden spec assumption: the result depends on the OS uid of the executing process,
and the WP-CLI sidecar path is UNRELIABLE for file deletion in this stack.**

---

## TL;DR / reliability matrix

| Path | Process uid | Meta cleared? | Files deleted? | Reports? | Reliable? |
|---|---|---|---|---|---|
| `wp elementor flush-css` (wpcli **sidecar** container) | 82 (Alpine www-data) | YES | **NO** (`unlink Permission denied`) | `Success` (lies) | **NO** |
| `wp elementor flush-css --regenerate` (sidecar) | 82 | YES | **NO** unlink + **NO** write (`file_put_contents` denied) | `Success` (lies) | **NO** |
| `files_manager->clear_cache()` via `wp eval-file` (sidecar) | 82 | YES | **NO** | n/a | **NO** |
| `files_manager->clear_cache()` run **in Apache** (uid 33) | 33 (Debian www-data, file owner) | YES | **YES (all 6 → 0)** | n/a | **YES** |
| `DELETE elementor/v1/cache` REST (Basic auth → Apache) | 33 | YES | **YES (all 6 → 0)** | HTTP 200 | **YES** |
| `files_manager->generate_css()` in Apache (uid 33, `--regenerate` half) | 33 | n/a | regenerates kit CSS (`post-4.css`); per-page CSS lazy on visit | n/a | **YES** |

**Bottom line:** the *Elementor API* (`clear_cache()` / the `DELETE /cache` REST route)
is reliable. The *WP-CLI command* is reliable **only when executed by the uid that owns the
CSS files**. In this Plan B stack the `wpcli` sidecar runs as a *different uid* than Apache,
so the CLI path silently fails to delete files while still printing `Success`.

---

## The command exists

`wp elementor flush-css --help` (alias of `flush_css`) is present with both flags:
- `[--network]` — "Flush CSS Cache for all the sites in the network."
- `[--regenerate]` — "Re-create the CSS files. Otherwise they will be created by a page visit."

## `--network` is multisite-only (noted)

Source: `plugins/elementor/modules/wp-cli/command.php:42-62`.
```php
$network = ! empty( $assoc_args['network'] ) && is_multisite();   // line 43
...
if ( $network ) { foreach ( get_sites() as ... ) { switch_to_blog(); handle_flush(...); restore_current_blog(); } }
else { handle_flush(...); }
```
- `wp eval 'echo is_multisite()...'` → **SINGLE-SITE**.
- On single-site, `--network` is **silently ignored** (the `&& is_multisite()` short-circuits).
  Empirically: `wp elementor flush-css --network` printed `Success: Flushed the Elementor CSS Cache`
  (the **single-site** message), NOT the per-site variant `... for site - <home>`, proving the
  network branch never ran. It is a documented no-op here, not an error.
- The multisite fan-out (≥2 subsites, `switch_to_blog` per site) was NOT exercised — this stack
  has no multisite. The multisite reliability question (the original WP title) remains a gate item;
  see "Impact" below.

## What `clear_cache()` actually does

Source: `plugins/elementor/core/files/manager.php:107-131`. It:
1. `glob(uploads/elementor/css/*)` and `unlink()` each file,
2. `delete_post_meta_by_key('_elementor_css')` (Post_CSS::META_KEY),
3. `delete_post_meta_by_key('_elementor_element_cache')` (Document_Base::CACHE_META_KEY),
4. `delete_post_meta_by_key` for Assets::ASSETS_META_KEY,
5. `delete_option(Frontend::META_KEY)`, `reset_assets_data()`,
6. fires `do_action('elementor/core/files/clear_cache')`.

It does **NOT** touch global-class design data (`_elementor_global_class_data`,
`_elementor_global_classes_*`, `_elementor_data`) — only the CSS cache. Confirmed empirically:
those meta keys survived every flush.

**Crucial:** `clear_cache()` never checks the return of `unlink()`; a failed unlink only emits
a PHP `Warning`. `handle_flush()` (`command.php:64-72`) then unconditionally calls
`\WP_CLI::success(...)`. So a *failed file delete still reports success.*

The single-site REST route is **`DELETE elementor/v1/cache`** → `clear_cache()`,
`permission_callback: current_user_can('manage_options')`
(`manager.php:266-278`, hooked on `rest_api_init` at `manager.php:197`). This is the route
`10-rest-api.md` reuses for `DELETE /cache`.

---

## Raw evidence

### 1. Prime cache (visit Elementor pages 10/12; post-4 is the global kit)
```
page 10/12: HTTP 200
uploads/elementor/css/  → base-desktop.css, global-10-/global-12-/local-10-/local-12-frontend-desktop.css, post-4.css  (6 files)
DB before: _elementor_css=3, _elementor_element_cache=2, _elementor_page_assets=2
```

### 2. WP-CLI flush from the sidecar (uid 82) — FILES NOT DELETED, but "Success"
```
$ wp elementor flush-css            # via wpcli sidecar container
Warning: unlink(.../base-desktop.css): Permission denied in .../manager.php on line 112
...(x6, one per file)...
Success: Flushed the Elementor CSS Cache
→ FILECOUNT after = 6   (UNCHANGED)
→ DB after: _elementor_css=0, _elementor_element_cache=0   (meta WAS cleared)
```

### 3. uid mismatch is the root cause (NOT an Elementor bug)
```
$ wpcli sidecar:        id → uid=82(www-data) gid=82(www-data)      # wordpress:cli-php8.2 = Alpine
$ wordpress apache:     id www-data → uid=33(www-data) gid=33       # wordpress:php8.2-apache = Debian
$ stat css dir:         www-data:www-data 775                       # owned by uid 33, group 33
```
The CSS dir is `775` owned by uid 33; uid 82 is neither owner nor in group 33 → cannot
unlink files in the directory (`is_writable(dir)=no`, `is_writable(file)=no`).

### 4. `files_manager->clear_cache()` via `wp eval-file` (sidecar uid 82) — same failure
```
RUN-UID: 82
FILES-BEFORE: 6  (each: writable-dir=no, writable-file=no)
...unlink Permission denied x6...
FILES-AFTER: 6
META-AFTER _elementor_css=0 _elementor_element_cache=0
VERDICT: FILES-REMAIN
```

### 5. `clear_cache()` run IN-PROCESS in Apache (uid 33) — CLEAN SUCCESS
(runner fetched over HTTP so Apache/PHP executes it as the file owner)
```
RUN-UID: 33
FILES-BEFORE: 6  (each: writable=yes)
FILES-AFTER: 0
META-AFTER _elementor_css=0 _elementor_element_cache=0
VERDICT: FILES-CLEARED
FS verify: ls css/ → empty
```

### 6. `DELETE elementor/v1/cache` REST endpoint (Basic auth → runs in Apache, uid 33) — RELIABLE
NOTE: permalinks are **plain** (`permalink_structure` is empty), so `/wp-json/...` does NOT
route (it returns the homepage HTML with HTTP 200 — a silent false-positive trap). REST must be
hit via `?rest_route=`:
```
$ curl -X DELETE -u admin:*** "http://localhost:8899/?rest_route=/elementor/v1/cache"
HTTP=200
FILECOUNT-BEFORE=6 → FILECOUNT-AFTER=0
DB after: _elementor_css=0, _elementor_element_cache=0
```

### 7. `--regenerate` half (`generate_css()`) in Apache (uid 33) — works
```
FILES-BEFORE-GENERATE: 0
CALLED: files_manager->generate_css()
FILES-AFTER-GENERATE: 1  → post-4.css (1229 bytes)   # regenerates the global/kit CSS eagerly
VERDICT: REGENERATED
```
Per-document CSS (`local-*`, `global-*`) is NOT eagerly regenerated by `generate_css()`; it is
recreated lazily on the next page visit (Elementor's documented behavior — confirmed: re-visiting
pages 10/12 recreated their files).

### 8. `--regenerate` from the sidecar (uid 82) — WORST CASE
```
$ wp elementor flush-css --regenerate     # sidecar
Warning: unlink(...) Permission denied  x6
Warning: file_put_contents(.../post-4.css): Failed to open stream: Permission denied  (base.php:194)
Success: Flushed the Elementor CSS Cache
→ FILECOUNT after = 6  (all original stale files SURVIVE; regen also failed to write)
```
Net effect: meta cleared in DB, but **stale files remain on disk** and regen could not overwrite
them — yet the command prints `Success`. This is the most dangerous mode (stale CSS served,
DB says cache is clean).

---

## Spec correction (confirms_spec = false)

The contract assumption (RESEARCH.md §7.2; `10-rest-api.md` design writes "auto-flush cache")
implicitly treats `wp elementor flush-css` / `files_manager->clear_cache()` as a reliable flush.
That is **only true when the flush runs as the uid that owns `uploads/elementor/css/*`.**

Corrections:
1. **`clear_cache()` / `flush-css` silently report success even when file deletion fails**
   (no return-value check; warnings only). Callers MUST NOT trust the success message — they
   must verify `uploads/elementor/css/` is empty (or that the meta + files are gone).
2. In the **Plan B sidecar topology** the `wpcli` container (uid 82, Alpine) ≠ Apache (uid 33,
   Debian), so the **WP-CLI path is unreliable for file deletion** here. The reliable path is the
   **in-process** one: the MCP plugin runs inside Apache/PHP-FPM (uid 33) and should call
   `files_manager->clear_cache()` directly, OR issue `DELETE elementor/v1/cache`. Both clear files.
3. **REST routing caveat:** permalinks are plain on this site → use `?rest_route=/elementor/v1/cache`,
   not `/wp-json/...` (the latter returns the homepage with HTTP 200 — a false positive).
4. **The original multisite `--network` reliability question is UNVERIFIED** (no multisite here).
   But the code path is known: `flush_css` iterates `get_sites()` with `switch_to_blog()` and calls
   the same `handle_flush()` per site — so it inherits the *exact same* "success-without-delete on
   uid mismatch" and "no return check" caveats, per subsite, with no per-site error reporting.

## Recommendation for the cache-service / design-system controller (the dependents)

- **Primary flush = in-process Elementor API**, not the CLI:
  `\Elementor\Plugin::$instance->files_manager->clear_cache();` (optionally `->generate_css();`
  to eagerly rebuild the kit). Because the MCP plugin runs inside the same PHP worker as Apache
  (the file owner), this deletes files reliably. The companion `DELETE elementor/v1/cache` REST
  route is the externally-callable equivalent (`manage_options`).
- **Do NOT rely on `wp elementor flush-css` from a separate CLI container** unless that container
  runs as the same uid/gid that owns `uploads/elementor/`. If a CLI flush is ever needed, run it
  **inside the web/PHP-FPM container as that uid** (e.g. `docker compose exec -u www-data ...`),
  not from a differently-imaged sidecar.
- **Always verify, never trust the success string.** After flush, assert
  `glob(uploads/elementor/css/*)` is empty (or that the targeted post's `_elementor_css` meta is
  gone). Surface a real error if files remain.
- **`--regenerate` is partial:** it eagerly rebuilds only the global/kit CSS; per-page CSS returns
  lazily on visit. For a deterministic "regenerated" check, either prime the relevant page URLs or
  accept lazy regeneration.
- **Multisite fan-out (when reached):** prefer iterating subsites and calling `clear_cache()`
  in-process per `switch_to_blog()` (same as `flush_css --network` does internally) **with a
  per-site files-cleared assertion**, rather than the single `--network` CLI invocation that
  hides per-site failures. The uid-ownership requirement applies per subsite.

## Impact on dependent WPs

- **Single-site cache flush (`POST /cache/regen`, `DELETE /cache`): GREEN.** The reused
  `DELETE elementor/v1/cache` route works and clears files+meta when called via REST/in-process.
  Implement the controller's auto-flush as an in-process `clear_cache()` call (+ optional
  `generate_css()`), with a post-flush "css dir empty" assertion. Use `?rest_route=` in tests
  (plain permalinks).
- **Multisite fan-out polish (the gate this spike owns): still requires a multisite probe** before
  it can be marked reliable. The mechanism and its pitfalls are now documented (uid ownership +
  silent-success + no per-site error). Recommend the per-site in-process `clear_cache()` + assertion
  strategy above; the gate can proceed on that design but the empirical multisite assertion is a
  follow-up (out of scope for this single-site live target).

## Cleanup

Throwaway HTTP runners removed from the served plugin dir
(`plugin/elementor-ultra-mcp/s07-runner.php`, `s07-regen.php`). Reusable eval script kept at
`spec/spikes/scripts/s07-clear-cache.php`. CSS cache left empty (clean) via the working REST DELETE.
