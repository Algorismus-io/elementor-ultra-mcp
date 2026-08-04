<?php
/**
 * WP-P01 — Activation handler: idempotent UPDATE_CLASS capability grant.
 *
 * Contract authority: 10-rest-api.md §0.3 (UPDATE_CLASS gate), §12 (`can_update_class`);
 * 12-error-taxonomy.md §3.4 (`CAPABILITY_MISSING`); 15-engineering-standards.md §3.3, §7;
 * spike WP-S05 (the EXACT grant + the FQCN/cap-name corrections).
 *
 * CRITICAL (spike WP-S05): the grant MUST use the LITERAL capability string
 * `elementor_global_classes_update_class`. We do NOT `use` or reference
 * `Elementor\Modules\GlobalClasses\Utils\Add_Capabilities` — that FQCN does NOT exist
 * and importing it would fatal. The real class is
 * `Elementor\Modules\GlobalClasses\Database\Migrations\Add_Capabilities`
 * (modules/global-classes/database/migrations/add-capabilities.php: const UPDATE_CLASS
 * line 8, the administrator-only grant `self::UPDATE_CLASS => [ 'administrator' ]` line 14,
 * `$role->add_cap()` line 24). Activation runs before `plugins_loaded`, so Elementor may
 * not be loaded — the literal string is required; do NOT depend on the Elementor class.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Core;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Registers/refreshes the migration-only `UPDATE_CLASS` capability idempotently.
 *
 * The Elementor migration grants UPDATE_CLASS to `administrator` only
 * (add-capabilities.php:14). On a canonical install where that migration ran an
 * administrator already holds it, so this grant is defensive and a harmless no-op
 * (`WP_Role::add_cap()` dedupes — spike WP-S05 verified a second grant adds 0 caps).
 * Its purpose is robustness for agency installs where the migration may not have
 * fired or where the configured agent user is not an administrator.
 */
final class Activator {

	/**
	 * The literal Elementor UPDATE_CLASS capability slug (add-capabilities.php:8).
	 * Hard-coded on purpose — the Elementor class may be unloaded at activation time.
	 */
	const UPDATE_CLASS = 'elementor_global_classes_update_class';

	/** One-shot diagnostics option recording that the activation grant ran. */
	const GRANTED_OPTION = 'emcp_update_class_granted';

	/**
	 * `register_activation_hook` callback. Idempotently grants UPDATE_CLASS to the
	 * administrator role plus any configured agent role(s), and records a diagnostics
	 * option. Safe to run on every (re)activation.
	 *
	 * @return void
	 */
	public static function activate() {
		self::grant_update_class();
		update_option( self::GRANTED_OPTION, time() );
	}

	/**
	 * Grant UPDATE_CLASS to `administrator` + any roles supplied via the
	 * `emcp_agent_roles` filter (spike WP-S05 — configurable agent role(s)). The grant
	 * is conditional on `WP_Role::has_cap()` (and `add_cap` is itself a no-op when the
	 * cap is already present), so it is idempotent and re-activation-safe.
	 *
	 * @return void
	 */
	public static function grant_update_class() {
		$roles = array_merge(
			array( 'administrator' ),
			(array) apply_filters( 'emcp_agent_roles', array() )
		);

		foreach ( array_unique( $roles ) as $role_name ) {
			self::grant_to_role( (string) $role_name );
		}
	}

	/**
	 * Re-grant safety net for the `administrator` role only (Detailed Requirements #7).
	 * Used by the cheap `admin_init` transient-guarded path so an updated-but-not-
	 * reactivated install where the migration never ran still gets the cap, without
	 * surprising privilege escalation for other roles.
	 *
	 * @return void
	 */
	public static function ensure_administrator_cap() {
		self::grant_to_role( 'administrator' );
	}

	/**
	 * Idempotently add UPDATE_CLASS to a single role if the role exists and lacks it.
	 *
	 * @param string $role_name WordPress role slug.
	 * @return void
	 */
	private static function grant_to_role( $role_name ) {
		$role = get_role( $role_name );
		if ( $role && ! $role->has_cap( self::UPDATE_CLASS ) ) {
			$role->add_cap( self::UPDATE_CLASS );
		}
	}
}
