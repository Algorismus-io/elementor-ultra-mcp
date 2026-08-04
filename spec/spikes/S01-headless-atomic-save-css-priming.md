# S01 — Headless atomic save + CSS priming

> Full empirical findings, raw evidence, and the recorded working prime approach live in
> **[`WP-S01-findings.md`](./WP-S01-findings.md)** (same directory).

## Verdict (summary)

**PASS.** Headless `Document::save(['elements'=>…,'settings'=>…])` of a V4 atomic tree writes
`_elementor_data` and validates atomic props, but emits **NO front-end atomic CSS** on its own —
confirming the spec assumption. A dedicated prime step is required and **both** RESEARCH.md §7.4
approaches work:

- **Approach A (loopback)** — server-side HTTP GET that runs the frontend render. PASS, with a
  host-resolution caveat (use `127.0.0.1` + explicit `Host` header + `redirection:0` when
  `siteurl` is not reachable from the WP process).
- **Approach B (programmatic)** — in-process `do_action('elementor/post/render', $id)` then
  `do_action('elementor/frontend/after_enqueue_post_styles')`. PASS. **Recommended default for
  WP-P04** (no network dependency). `do_action('elementor/atomic-widgets/styles/register')` DOES
  fire outside a real render context.

## Two gates a prime MUST satisfy (see findings for evidence)

1. Invalidate atomic cache-validity first (`elementor/atomic-widgets/styles/clear` for
   `local`/`global`/`base`, or `files_manager->clear_cache()`), else `CSS_Files_Manager::get()`
   treats the cache as valid and writes nothing.
2. Run as the web-server user that owns `uploads/elementor/css/` (the REST request path does;
   the `wpcli` container's uid 82 ≠ the wordpress container's uid 33 and cannot write).

## Spike-gate

S1 = PASS with recorded approach → unblocks WP-P04, `page.build`, `page.replace_tree`,
`convert.html_to_page`, WP-Q06.

## Artifacts

- Fixture: `fixtures/s01-atomic-hero.json`
- Scripts: `scripts/s01-save-atomic-tree.php`, `scripts/s01-prime-approach-a-loopback.php`,
  `scripts/s01-prime-approach-b-programmatic.php`, `scripts/s01-assert-css.mjs`
