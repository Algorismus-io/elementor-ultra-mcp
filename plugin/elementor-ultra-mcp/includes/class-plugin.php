<?php
/**
 * WP-P01 — `Plugin` singleton: the load-bearing scaffold every other PHP WP loads against.
 *
 * Contract authority: 10-rest-api.md §0.1 (`REST_NAMESPACE`), §12 (`plugin_version`);
 * 15-engineering-standards.md §3.2 (namespace `Elementor\Ultra`), §7 (version guards refuse to
 * bootstrap controllers on an incompatible Elementor major and report via `site/capabilities`
 * rather than fatally erroring).
 *
 * Boot order in {@see Plugin::init()} is deterministic and FULLY guarded: Guards ->
 * (WP-P14) Op_Log store -> (WP-P02) REST registrar -> (WP-P16) Abilities registrar. Each later
 * stage is referenced by FQCN behind `class_exists`, so those WPs hook in without editing this
 * file, and this file is safe to ship before they exist.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra;

use Elementor\Ultra\Core\Guards;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * The companion-plugin singleton. Always instantiable (even with Elementor absent) so
 * `site/capabilities` can report health; only registers controllers when Elementor is
 * present and compatible.
 */
final class Plugin {

	/** REST namespace every controller registers under (10-rest-api.md §0.1). FROZEN. */
	const REST_NAMESPACE = 'elementor-ultra/v1';

	/** Plugin version, reported as `plugin_version` in `site/capabilities` (10-rest-api.md §12). */
	const VERSION = '1.0.0';

	/** Minimum supported Elementor core version (15-engineering-standards.md §7). */
	const MIN_ELEMENTOR = '4.1.0';

	/**
	 * The shared Guards service (experiment/Pro/atomic/capability probes). Constructed in
	 * {@see Plugin::init()} and exposed for controllers as `Plugin::instance()->guards`.
	 *
	 * @var Guards|null
	 */
	public $guards = null;

	/**
	 * Whether the boot gate cleared (Elementor present + compatible) and controllers were wired.
	 *
	 * @var bool
	 */
	private $booted = false;

	/** Singleton instance. */
	private static ?Plugin $instance = null;

	/** Private constructor — use {@see Plugin::instance()}. */
	private function __construct() {}

	/**
	 * The singleton accessor. ALWAYS returns an instance (15-engineering-standards.md §7 — the
	 * probe must work even when controllers are not booted).
	 */
	public static function instance(): Plugin {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Boot gate (Detailed Requirements #2). Construct Guards unconditionally so probes work, then
	 * either wire controllers (Elementor present + compatible) or register an admin notice. NEVER
	 * fatals on absent/incompatible Elementor.
	 *
	 * @return void
	 */
	public function boot() {
		if ( null === $this->guards ) {
			$this->guards = new Guards();
		}

		if ( ! $this->guards->is_elementor_active() ) {
			$this->register_missing_elementor_notice();
			return;
		}

		if ( ! $this->guards->is_elementor_compatible() ) {
			$this->register_incompatible_elementor_notice();
			return;
		}

		$this->init();
	}

	/**
	 * Deterministic init (Detailed Requirements #3, Implementation Notes). Runs only when Elementor
	 * is present + compatible. Wires later WPs' registrars by FQCN behind `class_exists` so they can
	 * hook in without editing this spine file. This WP NEVER registers routes itself.
	 *
	 * @return void
	 */
	private function init() {
		$this->booted = true;

		// (WP-P14) Op-log store init — guarded; absent before WP-P14 ships.
		if ( class_exists( '\Elementor\Ultra\Core\Op_Log' ) && method_exists( '\Elementor\Ultra\Core\Op_Log', 'init' ) ) {
			\Elementor\Ultra\Core\Op_Log::init();
		}

		// (WP-P02) REST registrar — the controller registration owner. Guarded.
		if ( class_exists( '\Elementor\Ultra\Rest\Registrar' ) && method_exists( '\Elementor\Ultra\Rest\Registrar', 'init' ) ) {
			\Elementor\Ultra\Rest\Registrar::init();
		}

		// (Contract 18 §7 "Font system strategy") Render-time normalization of the natively
		// collected font values: cache invalidation re-collects RAW stack/`var()` values AFTER the
		// prime-time option rewrite, so the consumption seam must normalize too or converted pages
		// load no fonts on the next render. Guarded — absent class is a no-op.
		if ( class_exists( '\Elementor\Ultra\Core\Fonts_Service' ) && method_exists( '\Elementor\Ultra\Core\Fonts_Service', 'register_frontend_normalization' ) ) {
			\Elementor\Ultra\Core\Fonts_Service::register_frontend_normalization();
		}

		// Multi-word font variables written unquoted by Elementor in kit CSS fail CSS parsing.
		// A late wp_head <style> override fixes the broken --font-* variable values.
		if ( class_exists( '\Elementor\Ultra\Core\Fonts_Service' ) && method_exists( '\Elementor\Ultra\Core\Fonts_Service', 'register_font_var_css_fix' ) ) {
			\Elementor\Ultra\Core\Fonts_Service::register_font_var_css_fix();
		}

		// Elementor 4.1.x atomic zero-size compat: the real save-time atomic Style_Parser rejects a
		// zero-valued Size (padding:0 etc.) because Elementor stringifies it to "0" and
		// Size_Prop_Type::validate_value mishandles empty("0"). Patch the style schema so zeros
		// validate. Guarded — no-op when the atomic Size prop type is absent. See class docblock.
		if ( class_exists( '\Elementor\Ultra\Core\Atomic_Size_Compat' ) && method_exists( '\Elementor\Ultra\Core\Atomic_Size_Compat', 'register' ) ) {
			\Elementor\Ultra\Core\Atomic_Size_Compat::register();
		}

		// (WP-P16) Abilities registrar — secondary WP-Abilities path; graceful no-op when absent.
		if ( class_exists( '\Elementor\Ultra\Abilities\Server_Registrar' ) && method_exists( '\Elementor\Ultra\Abilities\Server_Registrar', 'init' ) ) {
			\Elementor\Ultra\Abilities\Server_Registrar::init();
		}
	}

	/** Whether controllers were wired (Elementor present + compatible). */
	public function is_booted(): bool {
		return $this->booted;
	}

	/** Register the "Elementor not active" admin notice (never fatal). */
	private function register_missing_elementor_notice() {
		add_action(
			'admin_notices',
			static function () {
				echo '<div class="notice notice-error"><p>';
				echo esc_html__(
					'Elementor Ultra MCP requires Elementor to be installed and active. Its REST routes are disabled until Elementor is active.',
					'elementor-ultra-mcp'
				);
				echo '</p></div>';
			}
		);
	}

	/** Register the "Elementor too old" admin notice (never fatal; 15-engineering-standards.md §7). */
	private function register_incompatible_elementor_notice() {
		add_action(
			'admin_notices',
			function () {
				echo '<div class="notice notice-error"><p>';
				printf(
					/* translators: 1: detected Elementor version, 2: minimum supported version. */
					esc_html__(
						'Elementor Ultra MCP requires Elementor %2$s or newer (detected %1$s). Its REST routes are disabled; capabilities still report site health.',
						'elementor-ultra-mcp'
					),
					esc_html( (string) $this->guards->elementor_version() ),
					esc_html( self::MIN_ELEMENTOR )
				);
				echo '</p></div>';
			}
		);
	}
}
