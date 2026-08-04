# WP-S05 — UPDATE_CLASS capability presence for the agent user (LIVE findings)

- **Spike:** WP-S05 — Spike: UPDATE_CLASS capability presence for the agent user on a target install
- **Target:** Plan B docker-compose, http://localhost:8899 — Elementor 4.1.1 + Pro 4.1.0, V4 experiments active (e_atomic_elements + e_classes + e_variables).
- **Agent user:** `admin` (ID 1, role `administrator`), Application Password Basic auth `admin:SET-VIA-WP_APP_PASSWORD-ENV`.
- **Date:** 2026-06-07
- **Verdict:** PASS. The cap is PRESENT on this install. The migration-not-run case produces a clean 403, and the idempotent `add_cap` grant restores it. `confirms_spec = true` for the central claim; **two precise spec corrections** below.

---

## QUESTION

Does the admin user actually HAVE `elementor_global_classes_update_class` (granted by Elementor's
add-capabilities migration to `administrator` only)? Does the global-classes REST `PUT
/wp-json/elementor/v1/global-classes` return 200 vs 403 with our app-password admin? Is the
companion plugin's idempotent grant needed on THIS install?

## METHOD

1. PHP probe via `user_can(admin, ...)` and `current_user_can(...)` after `wp_set_current_user`, plus dump of the `administrator` role cap list (`spec/spikes/scripts/s05-probe-update-class.php`).
2. Located the cap constant + migration + REST permission_callback in the live Elementor source (`spec/spikes/scripts/s05-find-class.php`).
3. Live REST: GET + PUT against `elementor/v1/global-classes` with the app-password (Basic auth).
4. Negative repro: `wp cap remove administrator elementor_global_classes_update_class` → re-test PUT (expect 403).
5. Idempotent restoration: `add_cap` grant run twice (`spec/spikes/scripts/s05-grant-idempotent.php`) + `wp cap add` (twice) on a custom `elementor_agent` role; re-test PUT (expect non-403). Baseline restored at the end.

---

## RAW EVIDENCE

### 1. Cap IS present (baseline) — PHP probe

```
admin user ID: 1
admin roles: administrator

user_can:elementor_global_classes_update_class: TRUE
current_user_can:elementor_global_classes_update_class: TRUE

--- administrator role caps containing 'global_classes' or 'elementor' ---
  role-cap:elementor_atomic_widgets_access_styles_tab: TRUE
  role-cap:elementor_atomic_widgets_edit_local_css_class: TRUE
  role-cap:elementor_global_classes_update_class: TRUE
  role-cap:elementor_global_classes_remove_class: TRUE
  role-cap:elementor_global_classes_apply_class: TRUE
  ...
administrator role has UPDATE_CLASS key: TRUE
administrator role UPDATE_CLASS value: true
```

### 2. Live source of truth (on disk, in the wordpress container)

`wp-content/plugins/elementor/modules/global-classes/database/migrations/add-capabilities.php`:

```php
namespace Elementor\Modules\GlobalClasses\Database\Migrations;
class Add_Capabilities extends Base_Migration {
    const UPDATE_CLASS    = 'elementor_global_classes_update_class';
    const REMOVE_CSS_CLASS = 'elementor_global_classes_remove_class';
    const APPLY_CSS_CLASS  = 'elementor_global_classes_apply_class';

    public function up() {
        $capabilities = [
            self::UPDATE_CLASS     => [ 'administrator' ],
            self::REMOVE_CSS_CLASS => [ 'administrator', 'editor', 'author', 'contributor', 'shop_manager' ],
            self::APPLY_CSS_CLASS  => [ 'administrator', 'editor', 'author', 'contributor', 'shop_manager' ],
        ];
        foreach ( $capabilities as $capability => $roles ) {
            foreach ( $roles as $role_name ) {
                $role = get_role( $role_name );
                if ( $role ) { $role->add_cap( $capability ); }
            }
        }
    }
}
```

`wp-content/plugins/elementor/modules/global-classes/global-classes-rest-api.php:154`:

```php
// PUT /elementor/v1/global-classes
'permission_callback' => fn() => current_user_can( Add_Capabilities::UPDATE_CLASS ),
// GET /elementor/v1/global-classes
'permission_callback' => fn() => is_user_logged_in(),
// GET /elementor/v1/global-classes/usage
'permission_callback' => fn() => current_user_can( 'manage_options' ),
```

REST constants: `API_NAMESPACE = 'elementor/v1'`, `API_BASE = 'global-classes'`.

### 3. Live REST — cap PRESENT (baseline)

GET (gate = `is_user_logged_in`) → 200:
```
{"data":[{"id":"s01hero",...},{"id":"s02card",...},...],"meta":[]}
HTTP_STATUS:200
```

PUT with minimal body (gate = `current_user_can(UPDATE_CLASS)`) → **400 invalid_order, NOT 403**
(the permission_callback PASSED; we hit the handler's business validation):
```
{"code":"invalid_order","message":"Invalid order: s01hero: missing, ...","data":{"status":400,"meta":[]}}
HTTP_STATUS:400
```

### 4. Negative repro — cap REMOVED → 403 (= CAPABILITY_MISSING)

```
$ wp cap remove administrator elementor_global_classes_update_class
Success: Removed 1 capability from 'administrator' role.

$ wp cap list administrator | grep global_classes
elementor_global_classes_remove_class
elementor_global_classes_apply_class          # <- update_class gone
```

PUT now → **403 rest_forbidden**:
```
{"code":"rest_forbidden","message":"Sorry, you are not allowed to do that.","data":{"status":403}}
HTTP_STATUS:403
```

GET still → 200 (proves the 403 is cap-specific, not an auth/app-password failure):
```
{"data":[{"id":"s01hero",...}],"meta":[]}
HTTP_STATUS:200
```

### 5. Idempotent grant restores the cap, and re-run is a no-op

`add_cap` (mirrors the migration), run twice in one process:
```
=== BEFORE grant ===
administrator has UPDATE_CLASS: FALSE
=== RUN 1: add_cap(UPDATE_CLASS) ===
  administrator: had=false -> now=true
=== RUN 2 (re-run, must be a no-op / safe) ===
  administrator: had=true -> now=true
```
(Note: `user_can(admin,...)` read FALSE *within the same PHP process* after the grant — this is
WordPress's per-request `WP_User` allcaps cache, computed at user-load before the role mutation.
It is NOT a real failure; a fresh process/request sees the cap. See cross-process confirmation
below.)

`wp cap add` idempotency at the CLI layer (custom `elementor_agent` role):
```
$ wp cap add elementor_agent elementor_global_classes_update_class
Success: Added 1 capability to 'elementor_agent' role.
$ wp cap add elementor_agent elementor_global_classes_update_class
Success: Added 0 capabilities to 'elementor_agent' role.   # <- true no-op
```

Cross-process confirmation after re-grant (fresh `wp eval` + fresh REST request):
```
$ wp cap list administrator | grep global_classes
elementor_global_classes_remove_class
elementor_global_classes_apply_class
elementor_global_classes_update_class            # <- restored

$ wp eval 'user_can(admin, UPDATE_CLASS)'  ->  TRUE

PUT /elementor/v1/global-classes  ->  400 invalid_order (cap PASS), NOT 403
```

Baseline left intact at end of spike: administrator has `update_class`; `user_can(admin)=TRUE`;
PUT returns 400 (gate passes); temporary `elementor_agent` role deleted.

---

## PRESENT / ABSENT MATRIX

| Scenario | cap on `administrator` role | `user_can(admin)` (fresh) | REST PUT result |
|---|---|---|---|
| (a) Elementor active, migration run (THIS install, baseline) | PRESENT | TRUE | 400 invalid_order (gate PASS) |
| (b) Migration-not-run simulated (`cap remove`) | ABSENT | FALSE | **403 rest_forbidden** (CAPABILITY_MISSING) |
| (c) Custom agent-equivalent role, no grant | ABSENT (role has no elementor caps by default) | n/a (no such user here) | would be 403 |
| (c') Custom agent role after `add_cap` grant | PRESENT | TRUE | gate PASS |
| (a') After idempotent re-grant on administrator | PRESENT | TRUE | 400 invalid_order (gate PASS) |

---

## VERDICT

**PASS.** On THIS install the admin app-password user HAS
`elementor_global_classes_update_class`: the migration ran (it grants to `administrator`, and
admin holds the administrator role), `user_can` returns TRUE, and the live REST `PUT
/elementor/v1/global-classes` clears the `current_user_can(UPDATE_CLASS)` permission gate
(it returns a 400 business error, never 403). The companion plugin's idempotent grant is **NOT
required to make THIS install work today** — but it remains necessary as defensive hardening for
the documented failure modes (migration-not-run timing, role-management plugins that strip caps,
custom admin-equivalent / agent roles, multisite role sync) and to support a configurable
non-administrator agent role. The grant + the WP-F05 `can_update_class` probe are both still
warranted.

## SPEC CORRECTIONS (confirms_spec for the central claim, but two factual fixes)

1. **Companion-plugin class FQCN / file path is wrong in the spec.** The spec / contract_refs cite
   `Add_Capabilities` at `Utils\Add_Capabilities` and `add-capabilities.php:14,24`. On Elementor
   4.1.1 the class is
   `Elementor\Modules\GlobalClasses\Database\Migrations\Add_Capabilities`
   (file `modules/global-classes/database/migrations/add-capabilities.php`). The constant is at
   **line 8** (`const UPDATE_CLASS = 'elementor_global_classes_update_class';`), the
   `administrator`-only grant is at **line 14** (`self::UPDATE_CLASS => [ 'administrator' ]`), and
   `$role->add_cap()` is at **line 24**. WP-P01 should reference its own literal cap string or this
   real FQCN — do NOT `use Elementor\Modules\GlobalClasses\Utils\Add_Capabilities` (it does not
   exist; that import would fatal).

2. **The secondary cap names in the spike summary are wrong.** The companion caps are
   `elementor_global_classes_remove_class` (const `REMOVE_CSS_CLASS`) and
   `elementor_global_classes_apply_class` (const `APPLY_CSS_CLASS`) — granted to
   administrator/editor/author/contributor/shop_manager. There is NO `..._create_class` or
   `..._delete_class` cap. Only `UPDATE_CLASS` is administrator-only and is the one that gates ALL
   global-class writes via the single PUT route. (`s05-probe-update-class.php` initially tested the
   wrong `create_class`/`delete_class` names and they returned FALSE because they do not exist.)

3. Confirmation of the spec's core mechanics that ARE correct:
   - The PUT permission_callback is exactly `current_user_can( Add_Capabilities::UPDATE_CLASS )`
     (`global-classes-rest-api.php:154`). Confirmed.
   - Absence → 403 on ALL global-class writes (there is a single PUT route for add/delete/modify/
     order — no separate per-operation routes). Confirmed: `{"code":"rest_forbidden", status:403}`.
   - GET routes use `is_user_logged_in()`; usage GET uses `manage_options` — these are NOT gated by
     UPDATE_CLASS, so reads stay available even when the write cap is missing.

## EXACT add_cap CALL WP-P01 MUST MAKE (idempotent, re-activation safe, configurable)

```php
// In the activation handler of elementor-ultra-mcp.php (or its activator class).
// Idempotent: WP_Role::add_cap() is a no-op when the cap is already granted.
function eumcp_grant_update_class_cap() {
    $cap = 'elementor_global_classes_update_class';
    // administrator always; plus any configured agent role(s).
    $roles = array_merge(
        [ 'administrator' ],
        (array) apply_filters( 'eumcp_agent_roles', [] ) // configurable agent role(s)
    );
    foreach ( array_unique( $roles ) as $role_name ) {
        $role = get_role( $role_name );
        if ( $role && ! $role->has_cap( $cap ) ) {
            $role->add_cap( $cap );
        }
    }
}
register_activation_hook( __FILE__, 'eumcp_grant_update_class_cap' );
```
Notes: do not hard-depend on Elementor's `Add_Capabilities` class at activation time (Elementor may
not be loaded then) — use the literal string. The `has_cap()` guard makes the write conditional;
even without it `add_cap` is already idempotent (verified: second `wp cap add` = "Added 0
capabilities"). Re-running on this install is a confirmed no-op.

## site/capabilities CROSS-CHECK (WP-F05)

`can_update_class` in the `site/capabilities` payload MUST be computed as
`current_user_can('elementor_global_classes_update_class')` for the authenticated user. This is the
exact predicate the live REST PUT gate uses, and the spike confirms it tracks live state across
processes (removing the cap → PUT 403; re-granting → PUT non-403). So the probe is faithful.

## IMPACT ON DEPENDENT WPs

- **S5 spike-gate: OPEN.** Design-system class-write WPs (`design.classes.*`, `design.deploy`) may
  proceed. On the canonical dev target the cap is present, so manual REST/MCP class writes work
  today with the admin app-password.
- **WP-P01 (plugin bootstrap/activation grant):** implement the idempotent `add_cap` above. Fix the
  two spec errors (FQCN/path and the secondary cap names). Grant target = `administrator` +
  configurable agent role(s). The grant is defensive (not required to unblock THIS install) but
  required for robustness across other installs.
- **WP-F05 (site/capabilities):** expose `can_update_class` =
  `current_user_can('elementor_global_classes_update_class')`. Map a false value, and any REST
  403 `rest_forbidden` on the global-classes PUT, to the `CAPABILITY_MISSING` error
  (`12-error-taxonomy.md`).
- **Error taxonomy / REST layer:** the missing-cap signature to detect and translate is
  `{"code":"rest_forbidden","message":"Sorry, you are not allowed to do that.","data":{"status":403}}`
  on PUT `/elementor/v1/global-classes`.

## ARTIFACTS

- `spec/spikes/scripts/s05-probe-update-class.php` — cap probe (user_can / current_user_can / role dump).
- `spec/spikes/scripts/s05-find-class.php` — locate Add_Capabilities + REST permission_callback in live source.
- `spec/spikes/scripts/s05-grant-idempotent.php` — idempotent add_cap grant (run twice).
