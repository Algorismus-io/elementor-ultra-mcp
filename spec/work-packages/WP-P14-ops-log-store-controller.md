---
id: WP-P14
title: Ops audit-log store + controller (one row per WRITE route; GET /ops/log)
layer: php
phase: v1
status: planned
depends_on: [WP-P01, WP-P02]
files_owned:
  - plugin/elementor-ultra-mcp/includes/rest/class-ops-controller.php
  - plugin/elementor-ultra-mcp/includes/core/class-op-log.php
contract_refs:
  - spec/contracts/10-rest-api.md §11 (OPS log), §0.8 (op_id), §0.11 (pagination)
  - spec/contracts/15-engineering-standards.md §3 (observability)
estimate: S
---

## Summary

The write audit trail. `Op_Log` is the shared store every WRITE route appends one row to `(op_id, post_id, user, route, before/after base_hash, result, ts)`; the controller exposes the paginated `GET /ops/log`. The store is created here so it can be wired into `Plugin::init()` early (before controllers register) and consumed by the writer (WP-P04), every controller, and the Abilities observability handler (WP-P16).

## Interface / Contract

- `\Elementor\Ultra\Core\Op_Log`:
  - `record( array $row ): int` — append a row `{op_id?,post_id?,user,route,before_hash?,after_hash?,result,ts,meta?}`; returns the row id.
  - `query( array $args ): array{items,next_cursor,total}` — filter by `post_id?`,`user?`, paginated.
  - `init(): void` — ensures the store exists (custom table OR a capped option/postmeta log — see Implementation Notes).
- `\Elementor\Ultra\Rest\Ops_Controller`:
  - `GET /ops/log` (CAP_MANAGE) — `{post_id?,user?,limit,cursor}` → `{items:[{op_id,post_id,user,tool,before_hash,after_hash,result,ts}],next_cursor,total}`. (Contract 10 §11)

## Dependencies & Inputs

- WP-P01 (`Plugin::init` wires `Op_Log::init()` early), WP-P02 (`Abstract_Controller`, `Permissions::can_manage`, `Pagination`).
- Contract 10 §11 (op-log row fields + route), §0.8 (op_id is recorded per write). Contract 15 §3 (observability/op-log is a cross-cutting PHP-owned concern).
- No Elementor API needed (pure WP storage).

## Detailed Requirements

1. **Store creation** (`Op_Log::init`): create a custom table `{$wpdb->prefix}emcp_ops` on plugin activation/init with columns `id, op_id (varchar 64), post_id (bigint), user_login (varchar), route (varchar), before_hash (char 32), after_hash (char 32), result (varchar), ts (bigint), meta (longtext)`, indexed on `post_id`, `op_id`, `ts`. Use `dbDelta`. (A capped-option fallback is acceptable only if a table cannot be created; prefer the table.)
2. **record** (Contract 10 §11): every WRITE route invocation appends exactly one row. The writer (WP-P04) and controllers call `Op_Log::record()` after the operation with the route name (e.g. `documents/save`), `op_id`, `post_id`, `user_login = wp_get_current_user()->user_login`, before/after `base_hash`, `result` (`ok`/error code), and `ts`. The row maps `route`→`tool` in the response (Contract 10 §11 example uses `tool`).
3. **query** (§11): filter by `post_id`/`user`; newest first; paginate per Contract 10 §0.11 (limit≤100, cursor). CAP_MANAGE.
4. **Idempotency support** (§0.8): the writer's idempotent-replay check may consult `Op_Log::query({op_id})` to detect a prior application (in addition to the `editor_settings._emcp_op_id` embed) — expose a `find_by_op_id( string $op_id, int $post_id ): ?array` helper.
5. **Retention**: cap the table (e.g. prune rows older than N or beyond M rows) to avoid unbounded growth; provide `prune( int $keep = 5000 )` called periodically (on record, every Nth).
6. **Shared, guarded consumption**: because `Op_Log::record` is called from many WPs, those WPs reference it behind `class_exists('\\Elementor\\Ultra\\Core\\Op_Log')` so a build without this WP degrades to no-logging (the WRITE still succeeds). This keeps WP-P14 a non-blocking dependency.

## Implementation Notes

- A custom table avoids bloating `wp_options`/postmeta and supports indexed `op_id`/`post_id` lookups for idempotency. Create it in `Op_Log::init` guarded by a stored schema-version option so `dbDelta` only runs on change.
- The op-log is the same store the Abilities observability handler (WP-P16) writes to (Contract 10 §11 "wired to the same store") — keep `record()` the single entry point.
- Keep `record` cheap and failure-tolerant: a logging failure must NEVER fail the underlying WRITE (wrap in try/catch, swallow + error_log).
- `route`→`tool` naming: store the REST route path; the controller may map it to the MCP tool name in the response if desired, but storing the route is sufficient and stable.

## Acceptance Criteria

- [ ] The `emcp_ops` table is created on activation/init via `dbDelta` with the documented columns + indexes.
- [ ] `Op_Log::record` appends one row with all Contract 10 §11 fields; a logging failure does not fail the caller.
- [ ] `GET /ops/log` returns paginated rows filtered by `post_id`/`user`, newest first, CAP_MANAGE.
- [ ] `find_by_op_id` returns a prior row for idempotency detection.
- [ ] `prune` caps growth.
- [ ] Consumers reference `Op_Log` behind a `class_exists` guard (so absence degrades to no-logging).
- [ ] PHPCS clean.

## Tests Required

- PHPUnit (wp-env): `test_table_created`; `test_record_appends_row`; `test_record_failure_does_not_throw`; `test_ops_log_query_filters_and_paginates`; `test_find_by_op_id`; `test_prune_caps_rows`.

## Parallelization Notes

- Wave-1/2. Owns `class-ops-controller.php` + `class-op-log.php` — disjoint from all other controllers and core services.
- `Op_Log::record` is consumed by WP-P04 and every WRITE controller behind a `class_exists` guard, so it is a SOFT dependency for them (they build without it). Wired into `Plugin::init()` by WP-P01 via FQN behind a guard (WP-P01 does not edit this file).
- Parallel-safe with every other WP-P##.
