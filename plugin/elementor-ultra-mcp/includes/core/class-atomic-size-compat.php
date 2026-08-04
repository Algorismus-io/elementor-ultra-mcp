<?php
/**
 * Atomic size-zero compatibility shim for Elementor 4.1.x atomic widgets.
 *
 * THE BUG (field-found on Elementor 4.1.4, live site :8913):
 *   Elementor stringifies atomic style Size values while building an element for save
 *   (Document::save -> get_elements_raw_data -> Atomic_Element_Base::get_data_for_save ->
 *   parse_atomic_styles). A numeric int 0 that WE persist (e.g. padding:0 — the kit bakes
 *   `padding:0` onto EVERY container to kill the intrinsic 10px leak) reaches the atomic
 *   Style_Parser as the STRING "0". Elementor's Size_Prop_Type::validate_value then rejects
 *   it, because BOTH guards fail for "0":
 *       ( ! empty( $value['size'] ) || 0 === $value['size'] )
 *   PHP treats empty("0") as TRUE, and 0 === "0" is FALSE (strict). Any zero-valued size
 *   (padding:0, margin:0, 0 inset/offset, 0 box-shadow offset) therefore HARD-FATALS the save
 *   with "Styles validation failed ... variants[0].padding: invalid_value". A non-zero size
 *   ("60") passes because empty("60") is FALSE, so only zero is affected.
 *
 *   The MCP dry_run validator (Validator/class-validator.php) uses an independent, more lenient
 *   size check that lacks this quirk, so dry_run reports VALID while the real save fatals — the
 *   exact discrepancy that shipped empty pages.
 *
 * THE FIX (this class):
 *   Hook Elementor's own `elementor/atomic-widgets/styles/schema` filter (the schema the
 *   authoritative Style_Parser consumes) and swap every Size_Prop_Type in the schema tree —
 *   including the ones nested inside Dimensions/Border-Width (Object), Box-Shadow (Array), and
 *   Union prop types — for a lenient subclass that coerces a zero-valued size to a strict int 0
 *   BEFORE the parent validator runs. Non-zero sizes are untouched; every other validation rule
 *   is preserved (the subclass only normalizes the zero representation, then defers to parent).
 *
 * This lives in the companion plugin (not Elementor core) so it survives Elementor upgrades and
 * ports to any site the plugin is installed on. It is a no-op on Elementor builds that do not
 * expose the atomic Size_Prop_Type / schema filter. See PHASE2-NOTES.md.
 */

namespace Elementor\Ultra\Core;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Atomic_Size_Compat {

	/** Guard so the schema walk installs the lenient subclass + filter exactly once. */
	private static $registered = false;

	/**
	 * Register the schema filter. Guarded: only runs when Elementor's atomic Size_Prop_Type and the
	 * schema filter are present (both shipped since the atomic-widgets module; absent = clean no-op).
	 */
	public static function register(): void {
		if ( self::$registered ) {
			return;
		}
		$size_class = '\Elementor\Modules\AtomicWidgets\PropTypes\Size_Prop_Type';
		if ( ! class_exists( $size_class ) ) {
			return;
		}
		self::$registered = true;

		// Register the lenient subclass lazily (the parent class is guaranteed present above).
		if ( ! class_exists( '\Elementor\Ultra\Core\Lenient_Size_Prop_Type' ) ) {
			// The subclass is declared in this file below; requiring self is unnecessary. It is defined
			// unconditionally at the bottom guarded by class_exists on the parent.
			self::maybe_define_subclass();
		}

		add_filter(
			'elementor/atomic-widgets/styles/schema',
			array( __CLASS__, 'patch_schema' ),
			5
		);
	}

	/**
	 * Define the lenient Size prop type subclass at runtime (its parent only exists once Elementor's
	 * atomic module is loaded, so it cannot be declared at file-parse time). Idempotent.
	 */
	private static function maybe_define_subclass(): void {
		if ( class_exists( '\Elementor\Ultra\Core\Lenient_Size_Prop_Type' ) ) {
			return;
		}
		// The parent class is only available at runtime (Elementor atomic module load
		// order), so the subclass must be declared dynamically.
		// phpcs:ignore Squiz.PHP.Eval.Discouraged
		eval(
			'namespace Elementor\\Ultra\\Core;' .
			'class Lenient_Size_Prop_Type extends \\Elementor\\Modules\\AtomicWidgets\\PropTypes\\Size_Prop_Type {' .
			'  protected function validate_value( $value ): bool {' .
			'    if ( is_array( $value ) && array_key_exists( "size", $value ) && is_numeric( $value["size"] ) && ( (float) $value["size"] ) === 0.0 ) {' .
			'      $value["size"] = 0;' . // strict int 0 — Elementor stringifies "0" on save; parent accepts int 0
			'    }' .
			'    return parent::validate_value( $value );' .
			'  }' .
			'}'
		);
	}

	/**
	 * Recursively replace every Size_Prop_Type in the atomic style schema with the lenient subclass.
	 *
	 * @param array $schema key => Prop_Type map returned by Style_Schema::get_style_schema().
	 * @return array patched schema.
	 */
	public static function patch_schema( $schema ) {
		if ( ! is_array( $schema ) ) {
			return $schema;
		}
		foreach ( $schema as $key => $prop_type ) {
			$schema[ $key ] = self::patch_prop_type( $prop_type );
		}
		return $schema;
	}

	/**
	 * Patch a single prop type: swap Size for the lenient subclass, or recurse into composites
	 * (Object shapes, Array item types, Union members) so nested sizes are covered too.
	 *
	 * @param mixed $prop_type
	 * @return mixed
	 */
	private static function patch_prop_type( $prop_type ) {
		$size_class   = '\Elementor\Modules\AtomicWidgets\PropTypes\Size_Prop_Type';
		$object_class = '\Elementor\Modules\AtomicWidgets\PropTypes\Base\Object_Prop_Type';
		$array_class  = '\Elementor\Modules\AtomicWidgets\PropTypes\Base\Array_Prop_Type';
		$union_class  = '\Elementor\Modules\AtomicWidgets\PropTypes\Union_Prop_Type';

		if ( $prop_type instanceof $size_class ) {
			return self::to_lenient( $prop_type );
		}
		if ( $prop_type instanceof $union_class ) {
			foreach ( $prop_type->get_prop_types() as $inner ) {
				$patched = self::patch_prop_type( $inner );
				if ( $patched !== $inner ) {
					$prop_type->add_prop_type( $patched ); // keyed by ::get_key(), overwrites the member
				}
			}
			return $prop_type;
		}
		if ( $prop_type instanceof $array_class ) {
			$item    = $prop_type->get_item_type();
			$patched = self::patch_prop_type( $item );
			if ( $patched !== $item ) {
				$prop_type->set_item_type( $patched );
			}
			return $prop_type;
		}
		if ( $prop_type instanceof $object_class ) {
			$shape   = $prop_type->get_shape();
			$changed = false;
			foreach ( $shape as $field_key => $field ) {
				$patched = self::patch_prop_type( $field );
				if ( $patched !== $field ) {
					$shape[ $field_key ] = $patched;
					$changed             = true;
				}
			}
			if ( $changed ) {
				$prop_type->set_shape( $shape );
			}
			return $prop_type;
		}
		return $prop_type;
	}

	/**
	 * Build a lenient Size instance that is byte-for-byte the original except for the class (so its
	 * available_units / required / dependencies / meta all carry over). Copies protected props via a
	 * closure bound to the Size class scope.
	 *
	 * @param object $original Size_Prop_Type instance.
	 * @return object Lenient_Size_Prop_Type instance.
	 */
	private static function to_lenient( $original ) {
		$lenient = \Elementor\Ultra\Core\Lenient_Size_Prop_Type::make();
		$copier  = \Closure::bind(
			function ( $dst ) {
				foreach ( get_object_vars( $this ) as $prop => $val ) {
					$dst->$prop = $val;
				}
			},
			$original,
			get_class( $original )
		);
		$copier( $lenient );
		return $lenient;
	}
}
