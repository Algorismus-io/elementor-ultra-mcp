---
id: WP-P01
title: Companion plugin bootstrap, activation, autoloader & capability/experiment guards
layer: php
phase: foundation
status: planned
depends_on: [WP-F05]
files_owned:
  - plugin/elementor-ultra-mcp/elementor-ultra-mcp.php
  - plugin/elementor-ultra-mcp/composer.json
  - plugin/elementor-ultra-mcp/readme.txt
  - plugin/elementor-ultra-mcp/phpcs.xml.dist
  - plugin/elementor-ultra-mcp/includes/class-plugin.php
  - plugin/elementor-ultra-mcp/includes/core/class-activator.php
  - plugin/elementor-ultra-mcp/includes/core/class-guards.php
contract_refs:
  - spec/contracts/10-rest-api.md §0.1 (namespace constant), §0.3 (UPDATE_CLASS grant), §12 (site/capabilities)
  - spec/contracts/12-error-taxonomy.md §3.4 (CAPABILITY_MISSING, EXPERIMENT_INACTIVE, PRO_REQUIRED)
  - spec/contracts/15-engineering-standards.md §1, §3 (PHP conventions), §7 (version guards)
estimate: M
---

## Summary

The plugin's entry point: the WordPress plugin header, the bootstrap that boots `Plugin` only when Elementor is present and compatible, the Composer manifest (Jetpack autoloader + optional `wordpress/mcp-adapter`), the activation hook that idempotently grants the migration-only `UPDATE_CLASS` capability, and the shared `Guards` helper that all controllers use to probe experiments / Pro / atomic availability. This is the foundation every other PHP WP loads against; it defines `Plugin::REST_NAMESPACE` and the version constants.

## Interface / Contract

Realizes the load-bearing plugin scaffold and constants other WPs depend on:

- `\Elementor\Ultra\Plugin` singleton with public constants:
  - `Plugin::REST_NAMESPACE = 'elementor-ultra/v1'` (Contract 10 §0.1 — the one constant every controller registers under).
  - `Plugin::VERSION = '1.0.0'` (reported as `plugin_version` in `site/capabilities`, Contract 10 §12).
  - `Plugin::MIN_ELEMENTOR = '4.1.0'`.
  - `Plugin::instance()` returns the singleton; `Plugin::instance()->guards` exposes the `Guards` service.
- `\Elementor\Ultra\Core\Guards` (instance, constructed by `Plugin`):
  - `is_elementor_active(): bool`, `is_pro_active(): bool`.
  - `elementor_version(): ?string`, `pro_version(): ?string`.
  - `atomic_available(): bool` — true when experiment `e_atomic_elements` is on (probe via `Plugin::$instance->experiments->is_feature_active('e_atomic_elements')`, see Implementation Notes).
  - `experiment_state(string $slug): string` — returns `active|inactive|default` per Contract 10 §12.
  - `experiments_map(): array` — the `experiments` block for `site/capabilities` (slugs: `e_atomic_elements`, `e_classes`, `e_variables`, `e_opt_in_v4_page`, `e_pro_atomic_form`, `e_wp_abilities_api`).
  - `can_update_class(): bool` = `current_user_can(Add_Capabilities::UPDATE_CLASS)`.
  - `require_pro(): true|WP_Error` and `require_experiment(string $slug): true|WP_Error` — return a `WP_Error` carrying taxonomy code `PRO_REQUIRED` / `EXPERIMENT_INACTIVE` (Contract 12 §3.4) with `add_data(['status'=>409])`, for controllers to short-circuit with.
- `\Elementor\Ultra\Core\Activator::activate()` — registered via `register_activation_hook`; idempotently grants `UPDATE_CLASS`.

## Dependencies & Inputs

- WP-F05: error taxonomy enum / `ErrorPayload` PHP constants (`PRO_REQUIRED`, `EXPERIMENT_INACTIVE`, `CAPABILITY_MISSING`). `Guards::require_*` builds `WP_Error`s with those codes; the actual `WP_Error`→envelope serialization lives in WP-P02 (this WP only constructs the `WP_Error`).
- Elementor APIs (cite in code as `path:line`):
  - `plugins/elementor/modules/global-classes/database/migrations/add-capabilities.php:8` — `const UPDATE_CLASS = 'elementor_global_classes_update_class'`; `:14` grants it to `administrator` only via the migration. The plugin re-grants idempotently on activation so the agent's user has it without running the migration.
  - `\Elementor\Plugin::$instance->experiments->is_feature_active( $slug )` for experiment probing (Experiments_Manager).
  - `defined('ELEMENTOR_VERSION')`, `defined('ELEMENTOR_PRO_VERSION')` for version guards.
- Contract 10 §0.1 (namespace), §12 (capabilities payload field names), §0.3 (UPDATE_CLASS gate).
- Contract 15 §1 (monorepo + Composer + Jetpack autoloader + optional mcp-adapter), §3 (namespace `Elementor\Ultra`, PHPCS WordPress+WordPress-Extra), §7 (version guards refuse to bootstrap on incompatible majors; report via capabilities instead of fatal).

## Detailed Requirements

1. **Plugin header** (`elementor-ultra-mcp.php`): `Plugin Name: Elementor Ultra MCP`, `Version: 1.0.0`, `Requires at least: 6.0`, `Requires PHP: 7.4`, `Requires Plugins: elementor`. Define `EMCP_VERSION`, `EMCP_FILE`, `EMCP_PATH`, `EMCP_URL` constants. Require the Composer autoloader (`vendor/autoload.php`) if present; otherwise a minimal SPL autoloader fallback mapping `Elementor\Ultra\` → `includes/`.
2. **Boot gate**: on `plugins_loaded` (priority after Elementor), check `did_action('elementor/loaded')` OR `defined('ELEMENTOR_VERSION')`. If absent or `version_compare(ELEMENTOR_VERSION, Plugin::MIN_ELEMENTOR, '<')`, do NOT boot controllers; instead register an admin notice and STILL allow `Plugin::instance()` to exist so `site/capabilities` can report `health` (Contract 15 §7: report via capabilities, never fatal-error).
3. **`Plugin` class**: PSR-4 namespace `Elementor\Ultra`. Singleton `instance()`. In `init()` (hooked on `elementor/init` or `plugins_loaded`): construct `Guards`; fire `rest_api_init` registration handled by WP-P02 (this WP only wires the boot order — it instantiates the REST registrar class name supplied by WP-P02 IF that class exists, guarded). Define `REST_NAMESPACE`, `VERSION`, `MIN_ELEMENTOR` constants.
4. **`composer.json`**: `name: elementor/ultra-mcp`, autoload PSR-4 `"Elementor\\Ultra\\": "includes/"`, require `automattic/jetpack-autoloader`, OPTIONAL `wordpress/mcp-adapter` in `suggest`/optional `require` so its absence is a graceful no-op (Contract 15 §1, §5 secondary path). `composer test:php` script placeholder (the actual PHPUnit suite is WP-Q-owned; this WP only declares the script name).
5. **`phpcs.xml.dist`**: rulesets `WordPress` + `WordPress-Extra`, `<file>includes</file>`, `<file>elementor-ultra-mcp.php</file>`, text-domain `elementor-ultra-mcp`, min WP/PHP version. (Contract 15 §3.1.)
6. **Activator (idempotent UPDATE_CLASS grant)**: `Activator::activate()` iterates roles `administrator`, `editor`, `shop_manager` (admin first; broaden cautiously — the migration grants only to administrator, but the agent user may be an editor on agency sites) and calls `$role->add_cap(Add_Capabilities::UPDATE_CLASS)` only if the role lacks it. Use the literal capability string `elementor_global_classes_update_class` if the Elementor class is not yet loaded at activation time (activation runs before `plugins_loaded`). MUST be idempotent (no error on re-activation). Record a one-shot option `emcp_update_class_granted` for diagnostics. This satisfies the LOCKED decision "companion plugin grants UPDATE_CLASS idempotently on activation."
7. **Re-grant safety net**: also re-run the grant on `admin_init` ONCE per request guarded by a transient, in case the plugin is updated (not re-activated) on a site where the migration never ran — but only for `administrator` to avoid surprising privilege escalation. Keep this cheap (transient guard).
8. **`Guards`**: implement all methods in Interface. `require_pro()` returns a `WP_Error('PRO_REQUIRED', 'Elementor Pro is required for this operation.', ['status'=>409,'meta'=>['feature'=>...]])` when `!is_pro_active()`. `require_experiment($slug)` returns `WP_Error('EXPERIMENT_INACTIVE', ..., ['status'=>409,'meta'=>['experiment'=>$slug]])` when the experiment is not active. Map `experiment_state` from `Experiments_Manager::STATE_ACTIVE/STATE_INACTIVE/STATE_DEFAULT`.
9. **No fatal on missing Pro / mcp-adapter**: all references to Pro classes go through `class_exists`/`function_exists`; the plugin loads and serves free routes regardless.
10. **`readme.txt`**: standard WP plugin readme stub (name, description, requires, changelog) — content minimal; it exists so the plugin packages cleanly.

## Implementation Notes

- Activation hook MUST be registered in the main plugin file (not inside a class method that only loads after `plugins_loaded`): `register_activation_hook( __FILE__, [ '\Elementor\Ultra\Core\Activator', 'activate' ] )`. Require `class-activator.php` directly at file scope (autoloader may not be ready at activation).
- The UPDATE_CLASS migration only grants to `administrator` (`add-capabilities.php:14`). On a fresh install where the migration HAS run, an administrator already has it; re-granting is a harmless no-op (`add_cap` dedupes). The point of this WP is robustness for agency installs where the migration may not have fired or where the agent user is not an administrator.
- Experiment probing: prefer `\Elementor\Plugin::$instance->experiments->is_feature_active( 'e_atomic_elements' )` over reading options directly. Wrap in `method_exists` guard for older Elementor.
- `e_opt_in_v4_page` and `e_pro_atomic_form` slugs come from RESEARCH.md §8 / Contract 10 §12 — probe them but do not assume they exist on every version; `experiment_state` returns `default` when the slug is unregistered.
- Keep `Plugin::init()` order deterministic: Guards → (WP-P14) Op_Log store init → (WP-P02) REST registrar → (WP-P16) Abilities registrar (all guarded by `class_exists`). Other WPs hook their controller registration into the REST registrar provided by WP-P02; this WP must NOT register routes itself.
- Do NOT add any HTTPS enforcement (Contract 10 §0.2 — would break LocalWP/wp-env, spike S6).

## Acceptance Criteria

- [ ] Activating the plugin on a clean WP+Elementor install does not fatal; deactivating/reactivating is idempotent.
- [ ] After activation, `current_user_can('elementor_global_classes_update_class')` is `true` for an administrator and for an editor user (re-grant), provable by a PHPUnit test.
- [ ] `Plugin::REST_NAMESPACE === 'elementor-ultra/v1'` and `Plugin::VERSION === '1.0.0'`.
- [ ] With Elementor inactive, the plugin loads without fatal and `Plugin::instance()->guards->is_elementor_active()` returns `false`; with Elementor older than `MIN_ELEMENTOR`, controllers are NOT registered and a notice is shown.
- [ ] `Guards::require_pro()` / `require_experiment()` return `WP_Error`s whose `get_error_code()` equals `PRO_REQUIRED` / `EXPERIMENT_INACTIVE` and whose data `status` is `409`.
- [ ] `Guards::experiments_map()` returns all six experiment slugs from Contract 10 §12 with values in `{active,inactive,default}`.
- [ ] `composer install` succeeds; `composer phpcs` runs the WordPress+WordPress-Extra ruleset cleanly on the files owned here.
- [ ] No reference to a Pro class is unguarded (grep shows every Pro symbol behind `class_exists`/`function_exists`).

## Tests Required

- PHPUnit (wp-env, Contract 14 §3): `test_activation_grants_update_class` (admin + editor); `test_activation_idempotent` (activate twice, no error, cap present once); `test_boot_without_elementor_no_fatal`; `test_guards_experiment_states`; `test_require_pro_returns_pro_required_error`.
- A unit assertion that `Plugin::REST_NAMESPACE` equals the frozen string (guards against drift).
- Fixture: none new (this WP precedes the fixture corpus).

## Parallelization Notes

- Parallel-safe with ALL other WP-P## packages: it owns only the bootstrap/activation/guards files; every other controller WP owns its own controller file and depends on the constants/Guards defined here at the contract level.
- This is a Wave-1 foundation-of-the-plugin WP. WP-P02 (REST base) and WP-P14 (op-log store) hook into `Plugin::init()` via class names; they do not edit `class-plugin.php` (the boot order references their classes by FQN behind `class_exists`).
- Sequencing: must merge before any controller WP can boot in wp-env, but controller WPs can be BUILT in parallel against this WP's frozen `Plugin`/`Guards` interface.

## Spike-Verified Corrections (Wave 1)

- **[S05]** The activation capability grant MUST use the literal cap string `elementor_global_classes_update_class`. You MUST NOT `use` or reference `Elementor\Modules\GlobalClasses\Utils\Add_Capabilities` — that FQCN does not exist and importing it would fatal. The real class is `Elementor\Modules\GlobalClasses\Database\Migrations\Add_Capabilities` (file `wp-content/plugins/elementor/modules/global-classes/database/migrations/add-capabilities.php`: const `UPDATE_CLASS` at line 8, the administrator-only grant `self::UPDATE_CLASS => [ 'administrator' ]` at line 14, `$role->add_cap()` at line 24). At activation time Elementor may not be loaded, so the literal string is required — do NOT depend on the Elementor class.
- **[S05]** The grant MUST target `administrator` plus any configured agent role(s), and MUST be idempotent (`$role->has_cap($cap)` guard, or rely on `WP_Role::add_cap()` being a no-op when already granted — verified: a second grant adds 0 capabilities). On the canonical install `administrator` already HOLDS `UPDATE_CLASS` (the migration grants it), so this grant is defensive/idempotent and is NOT required to unblock this install.
- **[S05]** You MUST NOT attempt to grant `elementor_global_classes_create_class` or `..._delete_class` — no such caps exist. The only companion caps are `elementor_global_classes_remove_class` and `elementor_global_classes_apply_class` (granted by Elementor to administrator/editor/author/contributor/shop_manager). Only `UPDATE_CLASS` is administrator-only and it gates ALL global-class writes via the single PUT route.
- **[S06]** You MUST NOT ship a `wp_is_application_passwords_available => __return_true` filter to make auth work — App-Password Basic auth already authenticates over plain HTTP with NO filter (WP 7.0 `wp_authenticate_application_password()` has no `is_ssl()`/availability gate). Any availability filter is OPTIONAL, applies only to App-Password CREATION via the WP admin UI on a non-SSL host, and if shipped MUST be guarded by `wp_get_environment_type() === 'local'` (e.g. `add_filter('wp_is_application_passwords_available', fn($a) => 'local' === wp_get_environment_type() ? true : $a)`). Production MUST keep HTTPS — never force-enable App Passwords over non-SSL in production.
