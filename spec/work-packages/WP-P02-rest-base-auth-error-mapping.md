---
id: WP-P02
title: REST routing base, Application-Password auth, permission callbacks & WP_Error→envelope mapping
layer: php
phase: foundation
status: planned
depends_on: [WP-P01, WP-F05]
files_owned:
  - plugin/elementor-ultra-mcp/includes/rest/class-rest-registrar.php
  - plugin/elementor-ultra-mcp/includes/rest/class-abstract-controller.php
  - plugin/elementor-ultra-mcp/includes/rest/class-response.php
  - plugin/elementor-ultra-mcp/includes/rest/class-permissions.php
  - plugin/elementor-ultra-mcp/includes/rest/trait-pagination.php
  - plugin/elementor-ultra-mcp/includes/core/class-error.php
contract_refs:
  - spec/contracts/10-rest-api.md §0.2 (auth), §0.3 (capability map), §0.5 (success envelope), §0.6 (error envelope), §0.7 (status mapping), §0.11 (pagination)
  - spec/contracts/12-error-taxonomy.md §2 (ErrorPayload shape), §3 (codes), §4 (WP_Error↔code mapping)
  - spec/contracts/15-engineering-standards.md §3.3 (capability boundary)
estimate: M
---

## Summary

The shared REST plumbing every controller inherits: the registrar that wires controllers on `rest_api_init` under namespace `elementor-ultra/v1`, an abstract base controller giving each controller the `{success,data}` success envelope and the canonical `WP_Error`→error-envelope mapping (Contract 10 §0.5/§0.6, Contract 12 §2/§4), the five permission callbacks for the capability gates, and the reusable pagination trait. No business routes live here — this is the seam that makes all WP-P06..P16 controllers consistent.

## Interface / Contract

- `\Elementor\Ultra\Rest\Rest_Registrar` — instantiated by `Plugin::init()` (WP-P01); on `rest_api_init` it calls `register_routes()` on every controller instance. Exposes `register_controller( Abstract_Controller $c )` so each controller WP self-registers via a filter/hook (`elementor_ultra/rest/controllers`) — controllers ADD themselves to the registrar without editing this file.
- `\Elementor\Ultra\Rest\Abstract_Controller` (abstract): base each controller extends. Provides:
  - `protected function namespace(): string` ⇒ `Plugin::REST_NAMESPACE`.
  - `protected function ok( $data, int $status = 200 ): WP_REST_Response` ⇒ `{success:true,data:$data}` envelope (Contract 10 §0.5).
  - `protected function fail( $code, $message, int $status, array $meta = [], array $errors = [], ?string $op_id = null ): WP_Error` ⇒ builds the Contract 10 §0.6 error envelope.
  - `protected function wp_error_to_response( WP_Error $e ): WP_REST_Response` (used when not letting WP serialize natively).
  - abstract `public function register_routes(): void`.
- `\Elementor\Ultra\Rest\Permissions` — static permission-callback factories returning closures for `register_rest_route`:
  - `can_read()` ⇒ `current_user_can('edit_posts')` (CAP_READ).
  - `can_edit_post( WP_REST_Request $r )` ⇒ `current_user_can('edit_post', (int)$r['id'])`, falling back to `current_user_can('edit_posts')` when there is no `id` (create) (CAP_EDIT_POST).
  - `can_manage()` ⇒ `current_user_can('manage_options')` (CAP_MANAGE).
  - `can_update_class()` ⇒ `current_user_can(Add_Capabilities::UPDATE_CLASS)` (CAP_UPDATE_CLASS).
  - `can_upload()` ⇒ `current_user_can('upload_files')` (CAP_UPLOAD).
  - Each returns `true` or a `WP_Error('CAPABILITY_MISSING', ..., ['status'=>403,'meta'=>['capability'=>..., 'user_id'=>...]])` (Contract 12 §3.4, NOT a bare `false`, so the body carries our envelope).
- `\Elementor\Ultra\Rest\Response` — static helpers shared by `ok`/`fail` and by direct callers.
- `trait Pagination` (`trait-pagination.php`) — `paginate( array $items, WP_REST_Request $r, ?int $total = null ): array` returning `{items,next_cursor,total}` and `read_pagination_args( WP_REST_Request $r ): array{limit,cursor,fields}` honoring `limit` (default 25, max 100), `cursor`, `fields[]` projection (Contract 10 §0.11).
- `\Elementor\Ultra\Core\Error` — central factory mirroring Contract 12 §2 `ErrorPayload`: `Error::make( string $code, string $message, int $status, array $meta = [], array $errors = [] ): WP_Error` and the `ELEMENTOR_SLUG_MAP` table (Contract 12 §4) translating Elementor's own REST slugs (`global_classes_limit_exceeded`→`BUDGET_EXCEEDED`, `invalid_order`→`INVALID_ORDER`, `DUPLICATED_LABEL`→`DUPLICATED_LABEL`, `rest_forbidden`→`CAPABILITY_MISSING`) into taxonomy codes.

## Dependencies & Inputs

- WP-P01: `Plugin::REST_NAMESPACE`, the `Plugin::instance()` boot that constructs `Rest_Registrar`, and `Guards` (controllers consult Guards for experiment/Pro gating, but this WP does not).
- WP-F05: the canonical error-code list + `ErrorPayload` field names (`code,message,http_status,retryable,surface,rpc_code,meta`). The PHP REST envelope (Contract 10 §0.6) is `{code,message,data:{status,op_id?,errors[]?,meta?}}` — note the PHP route envelope omits `retryable/surface/rpc_code` (those are TS-side fields the TS server adds when it maps the REST error to an MCP result). This WP emits the §0.6 shape; the §2 `ErrorPayload` is the TS view.
- Contract 10 §0.2 (Basic auth, no nonce; the `permission_callback` is the boundary), §0.3 (capability map table — quoted verbatim into `Permissions`), §0.7 (HTTP status table: 400/401/403/404/409/422/500/501 → codes).
- Contract 12 §4 (`WP_Error`↔code mapping table — implement `ELEMENTOR_SLUG_MAP` from it).
- WordPress core: `register_rest_route`, `WP_REST_Response`, `WP_Error`, `rest_authorization_required_code()`. Core returns 401 `rest_not_logged_in` for unauthenticated requests automatically (Contract 10 §0.2) — this WP does NOT reimplement 401.

## Detailed Requirements

1. **Namespace registration**: `Rest_Registrar` hooks `rest_api_init`; iterates registered controllers and calls `register_routes()`. Controllers register themselves via `add_action('elementor_ultra/rest/register', fn($reg) => $reg->register_controller(new Foo_Controller()))` — so adding a controller never edits this file (parallelism principle). Provide that action and call it inside `Rest_Registrar`.
2. **Success envelope** (Contract 10 §0.5): `ok($data)` ⇒ `new WP_REST_Response(['success'=>true,'data'=>$data], $status)`. NEVER wrap an already-wrapped payload.
3. **Error envelope** (Contract 10 §0.6): `fail()` returns a `WP_Error` whose `code` is the taxonomy code, `message` is human-readable, and `data` is `['status'=>$status,'op_id'=>$op_id (if set),'errors'=>$errors (if non-empty),'meta'=>$meta]`. When returned from a route callback, WordPress serializes it to exactly the §0.6 body with the matching HTTP status line. Verify the serialized shape matches §0.6 byte-for-byte (key order is not significant but key names are).
4. **Permission callbacks** (Contract 10 §0.3): implement the five gates with the EXACT `current_user_can` arguments from the table. `can_edit_post` must read the `id` URL param (the document/post id). Return `WP_Error('CAPABILITY_MISSING', ...)` with status 403 and `meta.capability` set to the failing cap string and `meta.user_id` to `get_current_user_id()`. Use `Add_Capabilities::UPDATE_CLASS` constant for the class gate (fall back to literal `elementor_global_classes_update_class` if the class is unavailable).
5. **`op_id` validation helper**: provide `Abstract_Controller::read_op_id( WP_REST_Request $r ): ?string` that validates against `^[A-Za-z0-9_.-]{1,64}$` (Contract 10 §0.8) and returns `null`/`WP_Error('SCHEMA_INVALID_PARAMS',...,400)` on malformed. (`SCHEMA_INVALID_PARAMS` maps to 400 in §0.7.)
6. **`base_hash` helper**: provide `Abstract_Controller::current_base_hash( int $post_id ): string` = `md5( (string) get_post_meta($post_id,'_elementor_data',true) )` (Contract 10 §0.8) and `assert_base_hash( int $post_id, ?string $expected, bool $force ): true|WP_Error` returning `WP_Error('CONCURRENCY_STALE_HASH', ..., ['status'=>409,'meta'=>['expected_hash'=>$expected,'actual_hash'=>$actual]])` on mismatch (taxonomy `CONCURRENCY_STALE_HASH`; REST surfaces it as `E_BASE_HASH_MISMATCH` per §0.8 — use the taxonomy code `CONCURRENCY_STALE_HASH` as the canonical `code`, and note: WP-P06+ write controllers consume this helper). Skip the check when `$expected` is null OR `$force` is true.
7. **Pagination trait** (Contract 10 §0.11): `read_pagination_args` parses `limit` (clamp 1..100, default 25), `cursor` (opaque string), `fields` (string[]). `paginate` applies `fields` projection per item (only listed top-level keys survive) and computes `next_cursor`. The cursor scheme is opaque and implementation-defined (recommend base64 of `{offset:int}` or a last-id keyset); document the chosen scheme so controllers stay consistent. Return `total` (`null` when not cheaply computable).
8. **Elementor slug mapping** (Contract 12 §4): `Error::from_wp_error( WP_Error $e ): WP_Error` re-codes a WordPress/Elementor `WP_Error` to a taxonomy code using `ELEMENTOR_SLUG_MAP`; unmatched slugs map to `UPSTREAM_ERROR` (default 502) unless they already carry a `status` in data.
9. **Never string-match throw messages** (Contract 10 §0.6, Contract 12 §4): the exception-classification helper for controllers — `Error::from_atomic_exception( \Exception $e, array $ctx ): WP_Error` — classifies a caught atomic save throw into `ATOMIC_SETTINGS_INVALID` vs `ATOMIC_STYLES_INVALID` using STRUCTURE/context provided by the caller (the validator WP-P03 supplies which phase threw), NOT by parsing the message; it copies the raw text into `meta.parser_errors` + appends to `message`. (The actual phase detection happens in WP-P03 which catches the throw; this helper just formats.)
10. **No HTTPS enforcement** (Contract 10 §0.2): the registrar/permission layer must not reject plain-HTTP requests (spike S6 / LocalWP).

## Implementation Notes

- WordPress already returns `401 rest_not_logged_in` before `permission_callback` runs when there are no valid credentials, so 401 (Contract 10 §0.7) needs no code here. Application Passwords populate `wp_get_current_user()` via HTTP Basic when `wp_is_application_passwords_available()` — the plugin relies on core; do not parse the `Authorization` header manually.
- Return `WP_Error` (not a `WP_REST_Response`) from permission callbacks so WordPress applies the status from `add_data(['status'=>403])`. A bare `false` yields core's generic `rest_forbidden`; we want our `CAPABILITY_MISSING` body, so always return the `WP_Error`.
- The success envelope mirrors Elementor's own variables REST `{success,data}` shape (`modules/variables/classes/rest-api.php:418-423`) — cite this in a code comment so the consistency is traceable.
- Keep `register_rest_route` `args` schemas in the CONTROLLER WPs, not here; this WP gives only the shared callbacks/helpers. The abstract controller may offer a `route( $path, $methods, $callback, $permission, $args )` convenience wrapper that prepends the namespace.
- Cursor scheme recommendation: keyset by post-id/term-id where a natural sort key exists (documents, templates, media), offset-based otherwise (ops log). Pick one per controller; the trait supports both via the opaque `cursor`.

## Acceptance Criteria

- [ ] A route registered through the registrar appears under `/wp-json/elementor-ultra/v1/...` and is callable with App-Password Basic auth.
- [ ] A 2xx response body is exactly `{"success":true,"data":{...}}` (no extra top-level keys).
- [ ] A failed permission callback yields HTTP 403 with body `{"code":"CAPABILITY_MISSING","message":...,"data":{"status":403,"meta":{"capability":...,"user_id":...}}}`.
- [ ] `fail()`/`Error::make()` produce the Contract 10 §0.6 shape with `op_id` and `errors[]` present only when supplied.
- [ ] `assert_base_hash` returns 409 `CONCURRENCY_STALE_HASH` on a stale hash and `true` on match or when `force`.
- [ ] `paginate` clamps `limit` to ≤100, honors `fields` projection, and emits `next_cursor:null` on the last page.
- [ ] `Error::from_wp_error` maps `global_classes_limit_exceeded`→`BUDGET_EXCEEDED`, `invalid_order`→`INVALID_ORDER`, `rest_forbidden`→`CAPABILITY_MISSING` per Contract 12 §4.
- [ ] No code path enforces HTTPS or rejects plain HTTP.
- [ ] PHPCS clean (WordPress + WordPress-Extra).

## Tests Required

- PHPUnit (wp-env): `test_success_envelope_shape`; `test_error_envelope_shape`; `test_permission_callbacks_return_wp_error_on_missing_cap` (one per gate); `test_can_edit_post_reads_id_param`; `test_base_hash_helper_detects_stale`; `test_pagination_clamps_and_projects`; `test_error_slug_mapping`.
- A contract test (mirrored in WP-Q) that a sample registered route returns the exact `{success,data}` envelope over REST with App-Password auth (proves the seam for the TS client).

## Parallelization Notes

- Parallel-safe with every controller WP (P06..P16) and the core-service WPs (P03..P05, P14): those own distinct files and consume this WP's `Abstract_Controller`/`Permissions`/`Pagination`/`Error` via the frozen interface.
- Must merge before any controller WP can register over REST in wp-env, but all controller WPs can be BUILT in parallel against this WP's frozen base-class API.
- Owns NO route logic — disjoint from all controllers by construction.

## Spike-Verified Corrections (Wave 1)

- **[S06]** The REST client/base MUST validate the response `Content-Type` is `application/json` before trusting any 2xx. On a site with plain permalinks, `/wp-json/...` 301s to a trailing-slash URL that returns the site homepage as HTTP 200 `text/html` — a silent false positive. The client MUST treat a non-JSON `Content-Type` (or unexpected HTML) as a transport failure, not success.
- **[S06]** The client MUST address routes via the `?rest_route=/<route>` query-string form (or require/enable pretty permalinks); prefer honoring the `rest_url()` the site reports over hardcoding `/wp-json/`. Verified working form: `http://<host>/?rest_route=/elementor/v1/global-classes` returns 200 JSON under Basic auth; the pretty path returns the homepage.
- **[S06]** App-Password Basic auth does NOT authenticate `admin-ajax.php` (`application_password_is_api_request` is false there; `save_builder`/`elementor_get_template_data` return HTTP 400 body `0`, current user stays logged-out). This is why writes MUST go through a custom REST route, not a proxied admin-ajax call.
- **[S05/S06]** Error mapping the auth layer MUST emit: missing/absent `Authorization` → 401 `rest_not_logged_in` → `AUTH_FAILED`; wrong username/app-password → 401 `rest_not_logged_in` → `AUTH_FAILED`; authenticated-but-no-cap on the global-classes PUT → 403 (or 401) `rest_forbidden` ("Sorry, you are not allowed to do that.") → `CAPABILITY_MISSING`. The no-cap signature on `PUT /elementor/v1/global-classes` is `{"code":"rest_forbidden","message":"Sorry, you are not allowed to do that.","data":{"status":403}}`. The cap gating that PUT is `current_user_can('elementor_global_classes_update_class')` at `wp-content/plugins/elementor/modules/global-classes/global-classes-rest-api.php:154`.
