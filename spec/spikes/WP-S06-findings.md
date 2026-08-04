# WP-S06 — Spike: Application Passwords over plain HTTP (local auth path)

- **Spike:** WP-S06
- **Date:** 2026-06-07
- **Target:** Plan B docker-compose live site — http://localhost:8899
- **Stack:** WordPress **7.0**, Elementor 4.1.1 + Pro 4.1.0, V4 experiments active
- **Auth under test:** `admin` + Application Password `admin:SET-VIA-WP_APP_PASSWORD-ENV` (App-Password UUID `4a06fbe4-3aef-449d-821a-4775f1936ebb`, name `elementor-mcp`)

---

## QUESTION (from WP)

Do WordPress Application Passwords work over **plain HTTP** on this local env (no HTTPS)?
Does `wp_is_application_passwords_available()` return true? If false, is the local-environment filter needed?

## VERDICT

**PASS.** Application Passwords (HTTP Basic auth) **authenticate successfully over plain HTTP** on this site — for both `wp/v2` routes and custom `elementor/v1` routes — returning **HTTP 200** with real JSON. Unauthenticated and wrong-password controls correctly return **HTTP 401**.

**The local-environment filter is NOT required for authentication.** `wp_is_application_passwords_available()` returns `false`, but that flag gates only the **admin-UI creation/listing** of App Passwords (and the `is_ssl()` advertisement) — it does **NOT** gate the runtime authentication of an *existing* App Password. WordPress 7.0's `wp_authenticate_application_password()` authenticates as long as (a) at least one App Password is in use and (b) the request is a REST/XML-RPC request. Neither condition involves SSL.

This is a **correction to the spec's stated assumption** (RESEARCH.md §8 / WP body): the spec assumed that if `wp_is_application_passwords_available()` is false over HTTP, a filter would be needed to make Basic auth *work*. In reality the availability flag and the auth path are decoupled — auth works regardless. The filter is only relevant if you also need to **create/manage** App Passwords through the WP admin UI on a non-SSL host.

---

## METHOD + RAW EVIDENCE

### 1. PHP probe — availability (`scripts/s06-probe-app-password.php`)

```
=== environment ===
wp_get_environment_type(): production          <-- NOTE: 'production', not 'local'
is_ssl(): false
site_url(): http://localhost:8899

=== application passwords availability ===
wp_is_application_passwords_available(): false
admin user ID: 1
wp_is_application_passwords_available_for_user(admin): false
admin can unfiltered_html: true
admin can edit_posts: true
existing app passwords count: 1
  - name=elementor-mcp uuid=4a06fbe4-3aef-449d-821a-4775f1936ebb

=== filter state ===
has filter 'wp_is_application_passwords_available': false
=== constants ===
WP_ENVIRONMENT_TYPE constant defined: false
```

So: availability = **false**, env = **production**, SSL = **false**, no filter installed — yet an App Password already exists and (as shown below) authenticates.

### 2. REST auth tests

**Permalink gotcha (important for downstream WPs):** `permalink_structure` is **empty (plain permalinks)**. Pretty REST paths `http://localhost:8899/wp-json/...` do **NOT** resolve — they 301 to a trailing-slash variant and then fall through to the site homepage (HTTP 200 HTML, `text/html`), which *looks* like success but is the front page, not the REST API. The REST API must be hit via the **`?rest_route=` query-string form** on this site (or pretty permalinks must be enabled).

Definitive results via `?rest_route=` (the auth question):

| # | Request | Auth | Result |
|---|---------|------|--------|
| H | `?rest_route=/wp/v2/users/me` | Basic (correct) | **200** JSON `{"id":1,"name":"admin",...}` |
| I | `?rest_route=/wp/v2/users/me` | none | **401** `rest_not_logged_in` |
| J | `?rest_route=/wp/v2/users/me` | Basic (WRONG pw) | **401** `rest_not_logged_in` |
| K | `?rest_route=/wp/v2/pages` | Basic (correct) | **200** JSON array of pages |
| L | `?rest_route=/elementor/v1/global-classes` | Basic (correct) | **200** `{"data":[{"id":"s01hero",...}],"meta":[]}` |
| M | `?rest_route=/elementor/v1/global-classes` | none | **401** `rest_forbidden` |

Raw curl evidence:

```
--- H) ?rest_route=/wp/v2/users/me, Basic auth ---
HTTP=200 CT=application/json; charset=UTF-8
{"id":1,"name":"admin","url":"http://localhost:8899",...}

--- I) ?rest_route=/wp/v2/users/me, NO auth (control) ---
HTTP=401 CT=application/json; charset=UTF-8
{"code":"rest_not_logged_in","message":"You are not currently logged in.","data":{"status":401}}

--- J) ?rest_route=/wp/v2/users/me, WRONG password (control) ---
HTTP=401 CT=application/json; charset=UTF-8
{"code":"rest_not_logged_in","message":"You are not currently logged in.","data":{"status":401}}

--- L) elementor/v1/global-classes, Basic auth ---
HTTP=200 CT=application/json; charset=UTF-8
{"data":[{"id":"s01hero","label":"s01hero"},{"id":"s02card","label":"s02card"},
         {"id":"s02rt","label":"s02rt"},{"id":"g-6737fb4","label":"s02rt-foreign"},
         {"id":"g-4a5b8fc","label":"DUP_s02rt-foreign"}],"meta":[]}

--- M) elementor/v1/global-classes, NO auth (control) ---
HTTP=401 CT=application/json; charset=UTF-8
{"code":"rest_forbidden","message":"Sorry, you are not allowed to do that.","data":{"status":401}}
```

Requirement #2 satisfied: a **custom elementor route** (`elementor/v1/global-classes`, an analogue for the future `elementor-ultra/v1` READ route) AND a **`wp/v2` route** both return 200 under Basic auth and 401 without it. Auth reaches `current_user_can` with no nonce.

### 3. Mechanism — WHY auth works while availability=false (`scripts/s06-mechanism.php`)

The installed WP 7.0 source of `wp_authenticate_application_password()` gates **only** on:

```php
if ( ! WP_Application_Passwords::is_in_use() ) { return $input_user; }   // a password exists -> passes
$is_api_request = (XMLRPC_REQUEST) || (REST_REQUEST);
$is_api_request = apply_filters( 'application_password_is_api_request', $is_api_request );
if ( ! $is_api_request ) { return $input_user; }                         // REST request -> passes
// ...then it validates the password hash and logs the user in.
```

There is **no `is_ssl()` check and no `wp_is_application_passwords_available()` check** in the authentication path. SSL/availability only affect the admin-UI advertisement & creation flow. No Basic-Auth plugin is installed (active plugins are only `elementor` + `elementor-pro`; no mu-plugins), so this is stock WordPress behavior.

### 4. Sanity check — Basic auth does NOT reach admin-ajax `save_builder` (RESEARCH.md §8)

```
--- N) POST admin-ajax.php action=elementor_ajax, Basic auth ---
HTTP=400, body: 0
--- O) POST admin-ajax.php action=elementor_get_template_data, Basic auth ---
HTTP=400, body: 0
```

admin-ajax is neither a REST nor XML-RPC request, so `application_password_is_api_request` is false there and the App-Password credentials are **not** consumed — the current user stays logged-out (`0`). This is exactly why a **custom REST save route** is needed instead of proxying Elementor's admin-ajax `save_builder`. Confirmed.

---

## ANSWERS TO THE WP

- **Availability over plain HTTP:** `wp_is_application_passwords_available()` = **false** (env=production, SSL=false).
- **Does Basic auth nevertheless authenticate over HTTP?** **YES** — 200 on custom + wp/v2 routes; 401 controls verified.
- **Is the local-environment filter needed?** **NO**, not for authentication. It would only be needed to *create/manage* App Passwords through the WP admin UI on a non-SSL host. On this site the password was already created (likely via WP-CLI / `WP_Application_Passwords::create_new_application_password()`, which bypasses the UI availability gate).

## SHIP RECOMMENDATION (filter)

- **Do NOT ship a `wp_is_application_passwords_available` => __return_true filter for the sake of authentication** — it is unnecessary; auth already works.
- **If** the plugin wants admins to be able to *create* App Passwords from the WP admin UI on a non-SSL local host, ship an **opt-in, environment-guarded** filter in WP-P01:
  ```php
  add_filter( 'wp_is_application_passwords_available', function ( $available ) {
      return ( 'local' === wp_get_environment_type() ) ? true : $available;
  } );
  ```
  NOTE: on THIS site `wp_get_environment_type()` returns `'production'` (no `WP_ENVIRONMENT_TYPE` / `WP_ENV` set). So either set `WP_ENVIRONMENT_TYPE=local` in the env, or gate on a host check (`is_local` semantics). **Production must keep HTTPS — never force-enable App Passwords over non-SSL in a real production env.**
- Simplest agency setup path that needs **no filter at all**: create the App Password via WP-CLI:
  `wp user application-password create admin elementor-mcp --porcelain`
  This produces a working credential regardless of the availability flag, exactly as observed here.

## AUTH_FAILED conditions recorded (12-error-taxonomy.md)

- No/missing `Authorization` header on an auth-required route -> **401 `rest_not_logged_in`** (wp/v2) — map to `AUTH_FAILED`.
- Wrong username/App-Password -> **401 `rest_not_logged_in`** — map to `AUTH_FAILED`.
- Authenticated but lacking capability on a custom route -> **401/403 `rest_forbidden`** ("not allowed to do that") — map to `AUTH_FAILED` (or a permission-specific code).
- Hitting a pretty `/wp-json/...` path with plain permalinks -> **301 then 200 HTML homepage** (a silent false-positive). The client MUST treat non-JSON `Content-Type` / unexpected HTML as a transport failure, not success.

## PER-SITE SETUP STEPS (for the contract note)

1. Install + activate the plugin (admin user must have `unfiltered_html` — admin id:1 confirmed `true`).
2. Ensure **pretty permalinks are enabled** OR have the client use `?rest_route=` (see Build Impact). Required for `/wp-json/...` style calls.
3. Create an Application Password — UI is fine on HTTPS; over local HTTP use WP-CLI: `wp user application-password create <user> <label> --porcelain`. (Optional WP-P01 `is_local`-guarded availability filter only if UI creation on HTTP is desired.)
4. Verify with `GET ?rest_route=/wp/v2/users/me` (or future `elementor-ultra/v1/site/capabilities`) using `Authorization: Basic base64(user:app-password)` — expect 200 + JSON.

---

## BUILD IMPACT (dependent WPs)

1. **Auth path is UNBLOCKED.** App-Password / HTTP Basic auth (no nonce) reaches both `wp/v2` and custom `elementor/v1` routes over plain HTTP and respects `current_user_can`. The entire proxied-tool REST auth path is validated. (10-rest-api.md confirmed.)
2. **No mandatory local filter for the plugin.** WP-P01 does NOT need to ship an availability filter just to make auth work. Any such filter is optional, must be `wp_get_environment_type()==='local'`-guarded, and on this site env reports `production` (so it would be inert unless `WP_ENVIRONMENT_TYPE=local` is set).
3. **Permalink/transport rule for the REST client (HIGH — affects every proxied tool):** This site uses **plain permalinks**, so `/wp-json/...` URLs 301 to the HTML homepage (200 text/html) — a silent false positive. The MCP REST client MUST either (a) use the `?rest_route=/<route>` form, or (b) require/enable pretty permalinks, and MUST validate `Content-Type: application/json` before trusting a 200. Recommend honoring the `rest_url()` reported by the site rather than hardcoding `/wp-json/`.
4. **Custom save route is justified.** Basic auth does not authenticate admin-ajax (`save_builder` returns `0`), confirming the proxied write path must go through a custom REST route, not admin-ajax.
