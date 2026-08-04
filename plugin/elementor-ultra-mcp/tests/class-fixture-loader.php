<?php
/**
 * WP-F06 — PHP fixture loader (the PHP MIRROR of the TS fixture-loader.ts).
 *
 * Reads the SAME `packages/shared/fixtures/` golden-tree directory so there is EXACTLY ONE copy of
 * every fixture (14-fixtures-harness.md §1). Parses the LOCKED envelope (§2) and mirrors the TS
 * loader's `requires`-skip logic BYTE-FOR-BYTE (§2/§3 step 1) so the TS (vitest) and PHP (PHPUnit)
 * runners skip the same fixtures given the same capability payload.
 *
 * AUTHORITY: `expect.valid` is the PHP `Validator::dry_run()` verdict (§3 — the single source of
 * truth). This loader only READS + GATES; the verdict comparison lives in test-dry-run-fixtures.php.
 *
 * The fixtures directory is resolved from (in order):
 *   1. the `ELEMENTOR_ULTRA_FIXTURES_DIR` constant (defined by bootstrap.php), or
 *   2. the `ELEMENTOR_ULTRA_FIXTURES_DIR` environment variable.
 * Under wp-env only the plugin dir is mounted, so bootstrap.php points this at the host-mounted
 * fixtures (see bootstrap.php).
 *
 * @package Elementor\Ultra\Tests
 */

namespace Elementor\Ultra\Tests;

/**
 * Reads + capability-gates golden fixtures, mirroring packages/server/src/test-harness/fixture-loader.ts.
 */
class Fixture_Loader {

	/**
	 * Sub-directories that hold envelope-bearing *.json fixtures (mirrors FIXTURE_SUBDIRS in the TS loader).
	 *
	 * @var string[]
	 */
	const SUBDIRS = array(
		'trees/v4/valid',
		'trees/v4/invalid',
		'trees/v3/valid',
		'trees/v3/invalid',
		'trees/design',
		'roundtrip',
		'envelopes',
	);

	/**
	 * Absolute path to the `packages/shared/fixtures` directory.
	 *
	 * @var string
	 */
	private $base_dir;

	/**
	 * @param string|null $base_dir Optional explicit fixtures dir; defaults to the resolved location.
	 */
	public function __construct( $base_dir = null ) {
		$this->base_dir = $base_dir ? $base_dir : self::resolve_base_dir();
	}

	/**
	 * Resolve the fixtures base dir from the constant or environment (see class doc).
	 *
	 * @return string
	 */
	public static function resolve_base_dir() {
		if ( defined( 'ELEMENTOR_ULTRA_FIXTURES_DIR' ) ) {
			return ELEMENTOR_ULTRA_FIXTURES_DIR;
		}
		$env = getenv( 'ELEMENTOR_ULTRA_FIXTURES_DIR' );
		if ( is_string( $env ) && '' !== $env ) {
			return $env;
		}
		// Last-resort: assume the monorepo layout (plugin at plugin/elementor-ultra-mcp).
		return dirname( __DIR__, 3 ) . '/packages/shared/fixtures';
	}

	/**
	 * The resolved fixtures base directory.
	 *
	 * @return string
	 */
	public function base_dir() {
		return $this->base_dir;
	}

	/**
	 * Load every fixture across the known sub-dirs as decoded envelope arrays, each with `__path`,
	 * `__dir`, and `__id` meta keys. Returns them sorted by path for deterministic ordering.
	 *
	 * @return array<int,array<string,mixed>>
	 */
	public function load_all() {
		$out = array();
		foreach ( self::SUBDIRS as $sub ) {
			$dir = $this->base_dir . '/' . $sub;
			if ( ! is_dir( $dir ) ) {
				continue;
			}
			$files = glob( $dir . '/*.json' );
			if ( false === $files ) {
				continue;
			}
			foreach ( $files as $path ) {
				$raw = file_get_contents( $path ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- test harness reads a local fixture file.
				$env = json_decode( $raw, true );
				if ( ! is_array( $env ) ) {
					continue;
				}
				$env['__path'] = $path;
				$env['__dir']  = $sub;
				$env['__id']   = isset( $env['id'] ) ? $env['id'] : basename( $path, '.json' );
				$out[]         = $env;
			}
		}
		usort(
			$out,
			static function ( $a, $b ) {
				return strcmp( $a['__path'], $b['__path'] );
			}
		);
		return $out;
	}

	/**
	 * Load only fixtures of a given `kind` (e.g. 'tree', 'roundtrip', 'smoke', 'design').
	 *
	 * @param string $kind Fixture kind.
	 * @return array<int,array<string,mixed>>
	 */
	public function load_by_kind( $kind ) {
		return array_values(
			array_filter(
				$this->load_all(),
				static function ( $env ) use ( $kind ) {
					return isset( $env['kind'] ) && $env['kind'] === $kind;
				}
			)
		);
	}

	/**
	 * Mirror of compareVersions() in the TS loader. Returns -1 / 0 / 1.
	 *
	 * @param string $a First version.
	 * @param string $b Second version.
	 * @return int
	 */
	public static function compare_versions( $a, $b ) {
		$pa  = array_map( 'intval', explode( '.', $a ) );
		$pb  = array_map( 'intval', explode( '.', $b ) );
		$len = max( count( $pa ), count( $pb ) );
		for ( $i = 0; $i < $len; $i++ ) {
			$x = isset( $pa[ $i ] ) ? $pa[ $i ] : 0;
			$y = isset( $pb[ $i ] ) ? $pb[ $i ] : 0;
			if ( $x !== $y ) {
				return $x < $y ? -1 : 1;
			}
		}
		return 0;
	}

	/**
	 * The single capability-gate predicate — MUST mirror isFixtureRunnable() in the TS loader EXACTLY
	 * (14-fixtures-harness.md §2/§3 step 1): every required experiment active; Pro active if required;
	 * site Elementor version >= requires.min_elementor. A fixture with no `requires` is always runnable.
	 *
	 * @param array<string,mixed> $env               Decoded fixture envelope.
	 * @param array<string,mixed> $caps              Capability snapshot:
	 *                                               { experiments: string[], pro: bool, elementor_version?: string }.
	 * @return bool
	 */
	public static function is_runnable( array $env, array $caps ) {
		if ( ! isset( $env['requires'] ) || ! is_array( $env['requires'] ) ) {
			return true;
		}
		$req         = $env['requires'];
		$experiments = isset( $caps['experiments'] ) && is_array( $caps['experiments'] ) ? $caps['experiments'] : array();

		if ( isset( $req['experiments'] ) && is_array( $req['experiments'] ) ) {
			foreach ( $req['experiments'] as $slug ) {
				if ( ! in_array( $slug, $experiments, true ) ) {
					return false;
				}
			}
		}
		if ( isset( $req['pro'] ) && true === $req['pro'] && empty( $caps['pro'] ) ) {
			return false;
		}
		if ( isset( $req['min_elementor'] ) && ! empty( $caps['elementor_version'] ) ) {
			if ( self::compare_versions( $caps['elementor_version'], $req['min_elementor'] ) < 0 ) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Build the capability snapshot from the live site (Elementor experiments + Pro + version), matching
	 * the shape `is_runnable()` expects. Used by the dry-run test so the SAME predicate gates both sides.
	 *
	 * @return array<string,mixed>
	 */
	public static function live_capability_snapshot() {
		$experiments = array();
		$version     = null;

		if ( class_exists( '\Elementor\Plugin' ) ) {
			$version = defined( '\ELEMENTOR_VERSION' ) ? ELEMENTOR_VERSION : null;
			$plugin  = \Elementor\Plugin::$instance;
			if ( $plugin && isset( $plugin->experiments ) ) {
				foreach ( array( 'e_atomic_elements', 'e_classes', 'e_variables', 'e_opt_in_v4_page', 'e_pro_atomic_form', 'e_wp_abilities_api' ) as $slug ) {
					if ( $plugin->experiments->is_feature_active( $slug ) ) {
						$experiments[] = $slug;
					}
				}
			}
		}

		return array(
			'experiments'       => $experiments,
			'pro'               => defined( '\ELEMENTOR_PRO_VERSION' ),
			'elementor_version' => $version,
		);
	}
}
