<?php
/**
 * COMPONENTS REST controller — headless create/update/list for Elementor's native components
 * module (SPEC 2.0 "ultra-mcp plugin extension").
 *
 * WHY THIS EXISTS: Elementor ships NO update-elements route at all, so a headless compiler could
 * never converge a redeploy of a changed component tree (it was warn-and-reuse). This controller
 * adds that missing PUT, plus create/list paths shaped for batch headless writes, by calling
 * {@see \Elementor\Modules\Components\Components_Repository} directly.
 *
 * LICENSING (deliberate, do not "optimise" away): Elementor's commercial tiering is MIRRORED, never
 * bypassed. Create requires an ACTIVE Pro license and update requires active-or-expired Pro — the
 * exact predicates {@see \Elementor\Modules\Components\Components_Access_Controller} applies to
 * the native routes — on top of `manage_options` + the plugin's App-Password auth. A site without
 * the entitlement gets 403 `PRO_REQUIRED`, and elementor-jsx falls back to inline expansion so
 * builds stay portable. We add capability Elementor lacks; we do not resell capability it sells.
 *
 * DRIFT-PROOFING (the load-bearing contract): every request runs Elementor's OWN validators — the
 * classes the native route uses, never a reimplementation:
 *   - {@see \Elementor\Modules\Components\Save_Components_Validator}    (≤100, unique title+uid)
 *   - {@see \Elementor\Modules\Components\Circular_Dependency_Validator} (DFS ≤50, uid-aware batches)
 *   - {@see \Elementor\Modules\Components\Non_Atomic_Widget_Validator}   (atomic-only trees)
 *   - {@see \Elementor\Modules\Components\OverridableProps\Component_Overridable_Props_Parser}
 * and the 422 error CODES are Elementor's verbatim (`components_validation_failed`,
 * `circular_dependency_detected`, `non_atomic_element_in_component`, `settings_validation_failed`) so
 * a client written against the native route reads identical failures here. Those codes are emitted as
 * raw `WP_Error`s on purpose — {@see Response::error()} collapses non-taxonomy codes to
 * INTERNAL_ERROR, which would break the native-parity contract (success payloads still use the §0.5
 * `{success,data}` envelope like every other controller).
 *
 * ROUTES (all under `elementor-ultra/v1`):
 *   - GET  /components                  — list `[{id,name,title,uid,isArchived}]` (native list shape
 *     + `title` alias) so uid→id reuse planning works without the native route.
 *   - POST /components                  — create, body `{status, items:[{uid,title,elements,settings?}]}`
 *     mirroring the native batch route byte-for-byte (autosave coerced to draft, title sanitized,
 *     `{uid: id}` map back, 201).
 *   - PUT  /components/{id}/elements    — THE MISSING UPDATE ROUTE: body `{elements, settings?}`;
 *     same validators; writes via the component document's own `save()` with `post_status: publish` —
 *     the exact write shape the native publish flow uses
 *     ({@see \Elementor\Modules\Components\Components_Repository::publish_component} →
 *     `copy_autosave_data_to_main_component_document_and_publish`), so save-time validation,
 *     versioning and CSS invalidation are all Elementor's own.
 *
 * REGISTRY WRITE PATH: `settings.overridable_props` is written via
 * {@see \Elementor\Modules\Components\Documents\Component::update_overridable_props()} rather
 * than riding through `save()`. Same parser, same meta the module's `after_save` hook writes — but
 * called explicitly so the write is deterministic for headless callers (the hook path also re-runs
 * the entitlement check mid-save, which would leave a half-created document on a lapsed license).
 * Entitlement itself is asserted UP FRONT by {@see self::assert_entitled()}.
 *
 * GUARD RAIL: when the components module is inactive (either experiment off, or Elementor too old to
 * ship it) every route answers 501 `EXPERIMENT_INACTIVE` naming the required experiments
 * (`e_components` + `e_atomic_elements`) instead of a fatal on the missing classes.
 *
 * Self-registers with the WP-P02 {@see Registrar} via `elementor_ultra/rest/register` — it never
 * edits the spine `class-registrar.php` / `class-plugin.php` (the parallelism principle).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Rest;

use Elementor\Ultra\Error_Codes;
use WP_Error;
use WP_REST_Request;
use WP_REST_Server;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * The COMPONENTS REST controller (free-tier create + update-elements + list).
 */
final class Components_Controller extends Abstract_Controller {

	/** The id path-segment pattern for component routes. */
	const ID_PATTERN = '(?P<id>\d+)';

	/** The experiments the native components module requires (module.php `is_experiment_active`). */
	const REQUIRED_EXPERIMENTS = array( 'e_components', 'e_atomic_elements' );

	/** Valid `status` enum for create — mirrors the native route args exactly. */
	const CREATE_STATUSES = array( 'publish', 'draft', 'autosave' );

	// =================================================================================================
	// Route registration.
	// =================================================================================================

	/**
	 * Register the three component routes under `elementor-ultra/v1`.
	 *
	 * @return void
	 */
	public function register_routes(): void {
		// GET /components — list (CAP_READ, matching the native list route's edit_posts gate).
		$this->route(
			'/components',
			WP_REST_Server::READABLE,
			array( $this, 'list_components' ),
			Permissions::can_read()
		);

		// POST /components — batch create (CAP_MANAGE — manage_options replaces the Pro license gate).
		// The args schema mirrors the native route's (components-rest-api.php) byte-for-byte.
		$this->route(
			'/components',
			WP_REST_Server::CREATABLE,
			array( $this, 'create_components' ),
			Permissions::can_manage(),
			array(
				'status' => array(
					'type'     => 'string',
					'required' => true,
					'enum'     => self::CREATE_STATUSES,
				),
				'items'  => array(
					'type'     => 'array',
					'required' => true,
					'items'    => array(
						'type'       => 'object',
						'properties' => array(
							'uid'      => array(
								'type'     => 'string',
								'required' => true,
							),
							'title'    => array(
								'type'      => 'string',
								'required'  => true,
								'minLength' => 2,
								'maxLength' => 200,
							),
							'elements' => array(
								'type'     => 'array',
								'required' => true,
								'items'    => array( 'type' => 'object' ),
							),
							'settings' => array(
								'type'     => 'object',
								'required' => false,
							),
						),
					),
				),
			)
		);

		// PUT /components/{id}/elements — the missing update route (CAP_MANAGE).
		$this->route(
			'/components/' . self::ID_PATTERN . '/elements',
			WP_REST_Server::EDITABLE,
			array( $this, 'update_elements' ),
			Permissions::can_manage(),
			array(
				'id'       => array(
					'type'     => 'integer',
					'required' => true,
					'minimum'  => 1,
				),
				'elements' => array(
					'type'     => 'array',
					'required' => true,
					'items'    => array( 'type' => 'object' ),
				),
				'settings' => array(
					'type'     => 'object',
					'required' => false,
				),
				// Optional re-stamp of `_elementor_component_uid`. Headless writers (elementor-jsx)
				// mint the uid as a TREE FINGERPRINT, so an update that leaves the old uid in place
				// makes every subsequent redeploy see "changed tree" and PUT again forever.
				'uid'      => array(
					'type'     => 'string',
					'required' => false,
				),
			)
		);
	}

	// =================================================================================================
	// GET /components — list.
	// =================================================================================================

	/**
	 * `GET /components`. Lists every component (native `Components_Repository::all()`, ≤100 by module
	 * design) as `[{id,name,title,uid,isArchived}]` — the native list shape plus a `title` alias, so
	 * uid-keyed redeploy planning (reuse/update decisions) works without the native route.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return \WP_REST_Response|WP_Error
	 */
	public function list_components( WP_REST_Request $request ) {
		unset( $request );
		$ready = $this->assert_components_ready();
		if ( is_wp_error( $ready ) ) {
			return $ready;
		}

		$components = \Elementor\Modules\Components\Components_Repository::make()->all()->all();

		$items = array();
		foreach ( $components as $component ) {
			$items[] = array(
				'id'         => $component['id'],
				'name'       => $component['title'],
				'title'      => $component['title'],
				'uid'        => $component['uid'],
				'isArchived' => isset( $component['is_archived'] ) ? (bool) $component['is_archived'] : false,
			);
		}

		return $this->ok( array_values( $items ) );
	}

	// =================================================================================================
	// POST /components — batch create (the free-tier path).
	// =================================================================================================

	/**
	 * `POST /components`. The native create flow with the license gate swapped for `manage_options`:
	 * Save/Circular/Non-Atomic validators first (Elementor's classes, native 422 codes verbatim), then
	 * `Components_Repository::create()` per item (autosave coerced to draft — native behavior), and the
	 * native `{uid: id}` map back with 201.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return \WP_REST_Response|WP_Error
	 */
	public function create_components( WP_REST_Request $request ) {
		$ready = $this->assert_components_ready();
		if ( is_wp_error( $ready ) ) {
			return $ready;
		}

		$entitled = $this->assert_entitled( 'create' );
		if ( is_wp_error( $entitled ) ) {
			return $entitled;
		}

		$save_status = (string) $request->get_param( 'status' );
		$items_param = $request->get_param( 'items' );
		if ( ! is_array( $items_param ) || array() === $items_param ) {
			return $this->fail(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'items must be a non-empty array of {uid,title,elements,settings?}.', 'elementor-ultra-mcp' ),
				400,
				array( 'path' => 'items' )
			);
		}

		$items      = \Elementor\Core\Utils\Collection::make( $items_param );
		$repository = \Elementor\Modules\Components\Components_Repository::make();

		$invalid = $this->run_native_validators( $items, $repository );
		if ( null !== $invalid ) {
			return $invalid;
		}

		// Per-item create — the native loop (sanitize title, parse settings, coerce autosave→draft,
		// repository create; failures collect per-uid → the native `settings_validation_failed` 422)
		// with ONE deviation, live-found on the phase-2 E2E: `overridable_props` must NOT ride
		// through `Components_Repository::create()`'s document save — the module's after_save hook
		// re-checks the entitlement mid-save and throws, which would leave a half-created document.
		// The registry is parsed FIRST (native parser, native error text) and written AFTER the
		// create via `Component::update_overridable_props()` — the hook's own parse+write, called
		// deterministically. A meta-write failure force-deletes the fresh document (native create
		// atomicity: repository create force-deletes on save failure too).
		$created           = array();
		$validation_errors = array();
		$status            = ( 'autosave' === $save_status ) ? \Elementor\Core\Base\Document::STATUS_DRAFT : $save_status;

		foreach ( $items->all() as $item ) {
			$uid = (string) $item['uid'];
			try {
				$parsed = isset( $item['settings'] ) && is_array( $item['settings'] )
					? $this->parse_component_settings( $item['settings'] )
					: array();

				$component_id = $repository->create(
					sanitize_text_field( (string) $item['title'] ),
					$item['elements'],
					$status,
					$uid,
					array()
				);

				if ( isset( $parsed['overridable_props'] ) ) {
					$document    = $repository->get( $component_id, false );
					$meta_result = null !== $document
						? $document->update_overridable_props( $item['settings']['overridable_props'] )
						: null;
					if ( null === $meta_result || ! $meta_result->is_valid() ) {
						if ( null !== $document ) {
							$document->force_delete();
						}
						throw new \Exception(
							esc_html(
								'Validation failed for overridable_props: '
								. ( null !== $meta_result ? $meta_result->errors()->to_string() : 'document unavailable after create' )
							)
						);
					}
				}

				$created[ $uid ] = $component_id;
			} catch ( \Exception $e ) {
				$validation_errors[ $uid ] = $e->getMessage();
				$created[ $uid ]           = null;
			}
		}

		if ( ! empty( $validation_errors ) ) {
			return $this->native_error(
				'settings_validation_failed',
				'Settings validation failed: ' . wp_json_encode( $validation_errors ),
				422
			);
		}

		return $this->ok( $created, 201 );
	}

	// =================================================================================================
	// PUT /components/{id}/elements — the missing update route.
	// =================================================================================================

	/**
	 * `PUT /components/{id}/elements`. Replaces a component's tree (and optionally its
	 * overridable-props registry) through the component document's own `save()`:
	 *
	 *  1. Same validators as create — circular (against the EXISTING component id, the exact call the
	 *     module's `before_save` hook makes) + atomic-only + the overridable-props parser (parsed
	 *     BEFORE any write so a bad registry never lands on a half-updated component).
	 *  2. `Component::save({elements, settings:{post_status:publish}})` on the MAIN document — the
	 *     native publish flow's write shape, so Elementor's own save-time validation/versioning/CSS
	 *     invalidation all run. Simplest-correct semantics: a headless update IS a publish; no
	 *     autosave dance (a stale editor autosave is a courtesy artifact — REST saves never block).
	 *  3. Registry meta via `update_overridable_props()` AFTER the tree write (NOT through save's
	 *     settings — the module's after_save hook would re-gate it on an active Pro license; see the
	 *     file header).
	 *  4. Optional `uid` re-stamp (`_elementor_component_uid`), uniqueness-checked against the other
	 *     components. Headless writers mint the uid as a tree FINGERPRINT; leaving the old one in
	 *     place would make every later redeploy re-detect "changed tree" and PUT again forever.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return \WP_REST_Response|WP_Error
	 */
	public function update_elements( WP_REST_Request $request ) {
		$ready = $this->assert_components_ready();
		if ( is_wp_error( $ready ) ) {
			return $ready;
		}

		$entitled = $this->assert_entitled( 'edit' );
		if ( is_wp_error( $entitled ) ) {
			return $entitled;
		}

		$component_id = (int) $request['id'];
		$elements     = $request->get_param( 'elements' );
		$settings     = $request->get_param( 'settings' );
		$settings     = is_array( $settings ) ? $settings : array();

		if ( ! is_array( $elements ) ) {
			return $this->fail(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'elements must be an array (the full component tree).', 'elementor-ultra-mcp' ),
				400,
				array( 'path' => 'elements' )
			);
		}

		// The MAIN document, never a user's autosave (include_autosave=false) — the update targets
		// the published tree exactly like the native publish flow.
		$repository = \Elementor\Modules\Components\Components_Repository::make();
		$document   = $repository->get( $component_id, false );
		if ( null === $document ) {
			return $this->fail(
				Error_Codes::NOT_FOUND,
				sprintf(
					/* translators: %d: component id. */
					__( 'Component %d was not found (no elementor_component document with that id).', 'elementor-ultra-mcp' ),
					$component_id
				),
				404,
				array( 'component_id' => $component_id )
			);
		}

		// 1a. Circular-dependency validation against the EXISTING id — the same
		// `Circular_Dependency_Validator::validate($id, $elements)` call the module's before_save
		// hook performs (running it here yields the native 422 code instead of a save-time throw).
		$circular = \Elementor\Modules\Components\Circular_Dependency_Validator::make()->validate( $component_id, $elements );
		if ( empty( $circular['success'] ) ) {
			return $this->native_error(
				'circular_dependency_detected',
				__( "Can't add this component - components that contain each other can't be nested.", 'elementor' ),
				422,
				array( 'caused_by' => isset( $circular['messages'] ) ? $circular['messages'] : array() )
			);
		}

		// 1b. Atomic-only validation — the same class/call the native create route uses.
		$non_atomic = \Elementor\Modules\Components\Non_Atomic_Widget_Validator::make()->validate( $elements );
		if ( empty( $non_atomic['success'] ) ) {
			return $this->native_error(
				\Elementor\Modules\Components\Non_Atomic_Widget_Validator::ERROR_CODE,
				__( 'Components require atomic elements only. Remove widgets to create this component.', 'elementor' ),
				422,
				array( 'non_atomic_elements' => isset( $non_atomic['non_atomic_elements'] ) ? $non_atomic['non_atomic_elements'] : array() )
			);
		}

		// 1c. Overridable-props registry parse BEFORE any write (native parser, native 422 code).
		$parsed_settings = null;
		try {
			$parsed_settings = $this->parse_component_settings( $settings );
		} catch ( \Exception $e ) {
			return $this->native_error(
				'settings_validation_failed',
				'Settings validation failed: ' . wp_json_encode( array( $component_id => $e->getMessage() ) ),
				422
			);
		}

		// 1d. uid re-stamp uniqueness — mirrors the native duplicate-uid rule
		// (Save_Components_Validator::validate_duplicated_values) scoped to an UPDATE: the validator
		// itself cannot be reused verbatim here because it would also flag this component's own
		// unchanged title as a duplicate of itself.
		$new_uid = $request->get_param( 'uid' );
		$new_uid = ( is_string( $new_uid ) && '' !== $new_uid ) ? $new_uid : null;
		if ( null !== $new_uid ) {
			foreach ( $repository->all()->all() as $existing ) {
				if ( (int) $existing['id'] !== $component_id && (string) $existing['uid'] === $new_uid ) {
					return $this->native_error(
						'components_validation_failed',
						sprintf(
							/* translators: %s: component uid. */
							esc_html__( "Component uid '%s' is duplicated.", 'elementor' ),
							$new_uid
						),
						422,
						array( 'conflicting_component_id' => (int) $existing['id'] )
					);
				}
			}
		}

		// 2. The tree write — Elementor's own document save (atomic settings validation, versioning
		// and CSS invalidation included). Save-time throws (e.g. an atomic-widget settings rejection
		// deep in the tree) surface as the native settings_validation_failed 422.
		try {
			$saved = $document->save(
				array(
					'elements' => $elements,
					'settings' => array(
						'post_status' => \Elementor\Core\Base\Document::STATUS_PUBLISH,
					),
				)
			);
		} catch ( \Exception $e ) {
			return $this->native_error(
				'settings_validation_failed',
				'Settings validation failed: ' . wp_json_encode( array( $component_id => $e->getMessage() ) ),
				422
			);
		}

		if ( ! $saved ) {
			return $this->fail(
				Error_Codes::UPSTREAM_ERROR,
				__( 'Elementor reported a failed component save (no exception).', 'elementor-ultra-mcp' ),
				502,
				array( 'component_id' => $component_id )
			);
		}

		// 3. Registry meta directly on the document (see the free-tier subtlety in the file header).
		if ( isset( $parsed_settings['overridable_props'] ) ) {
			$result = $document->update_overridable_props( $settings['overridable_props'] );
			if ( ! $result->is_valid() ) {
				// Unreachable in practice (step 1c parsed the same payload) — surfaced for safety.
				return $this->native_error(
					'settings_validation_failed',
					'Settings validation failed for component overridable props: ' . $result->errors()->to_string(),
					422
				);
			}
		}

		// 4. uid re-stamp LAST (after the tree actually landed) — the fingerprint must never claim a
		// tree that failed to save. `update_meta` is the document's own meta writer.
		$uid_updated = false;
		if ( null !== $new_uid && $new_uid !== (string) $document->get_component_uid() ) {
			$document->update_meta( \Elementor\Modules\Components\Documents\Component::COMPONENT_UID_META_KEY, $new_uid );
			$uid_updated = true;
		}

		return $this->ok(
			array(
				'id'          => $component_id,
				'uid'         => (string) $document->get_component_uid(),
				'uid_updated' => $uid_updated,
				'saved'       => true,
			)
		);
	}

	// =================================================================================================
	// Shared native-parity helpers.
	// =================================================================================================

	/**
	 * Run the native create-path validator chain (Save → Circular → Non-Atomic) in the native ORDER
	 * with the native 422 codes. Returns null when everything passes, a `WP_Error` otherwise.
	 *
	 * @param \Elementor\Core\Utils\Collection                       $items      The batch items.
	 * @param \Elementor\Modules\Components\Components_Repository    $repository The live repository.
	 * @return WP_Error|null
	 */
	private function run_native_validators( $items, $repository ) {
		$components = $repository->all();

		$result = \Elementor\Modules\Components\Save_Components_Validator::make( $components )->validate( $items );
		if ( empty( $result['success'] ) ) {
			return $this->native_error(
				'components_validation_failed',
				'Validation failed: ' . implode( ', ', $this->flatten_messages( isset( $result['messages'] ) ? $result['messages'] : array() ) ),
				422
			);
		}

		$circular = \Elementor\Modules\Components\Circular_Dependency_Validator::make()->validate_new_components( $items );
		if ( empty( $circular['success'] ) ) {
			return $this->native_error(
				'circular_dependency_detected',
				__( "Can't add this component - components that contain each other can't be nested.", 'elementor' ),
				422,
				array( 'caused_by' => isset( $circular['messages'] ) ? $circular['messages'] : array() )
			);
		}

		$non_atomic = \Elementor\Modules\Components\Non_Atomic_Widget_Validator::make()->validate_items( $items );
		if ( empty( $non_atomic['success'] ) ) {
			return $this->native_error(
				\Elementor\Modules\Components\Non_Atomic_Widget_Validator::ERROR_CODE,
				__( 'Components require atomic elements only. Remove widgets to create this component.', 'elementor' ),
				422,
				array( 'non_atomic_elements' => isset( $non_atomic['non_atomic_elements'] ) ? $non_atomic['non_atomic_elements'] : array() )
			);
		}

		return null;
	}

	/**
	 * Mirror of the native `parse_settings()`: run `settings.overridable_props` through Elementor's
	 * {@see \Elementor\Modules\Components\OverridableProps\Component_Overridable_Props_Parser} and
	 * throw on an invalid registry (the caller maps the throw to the native 422).
	 *
	 * @param array<string,mixed> $settings Raw request settings.
	 * @return array<string,mixed> Parsed settings (empty when nothing to parse).
	 * @throws \Exception When the overridable_props registry fails Elementor's parser.
	 */
	private function parse_component_settings( array $settings ): array {
		$result = array();

		if ( empty( $settings ) || ! isset( $settings['overridable_props'] ) ) {
			return $result;
		}

		$parser        = \Elementor\Modules\Components\OverridableProps\Component_Overridable_Props_Parser::make();
		$parse_result  = $parser->parse( $settings['overridable_props'] );

		if ( ! $parse_result->is_valid() ) {
			throw new \Exception(
				esc_html( 'Validation failed for overridable_props: ' . $parse_result->errors()->to_string() )
			);
		}

		$result['overridable_props'] = $parse_result->unwrap();

		return $result;
	}

	/**
	 * Guard rail: 501 `EXPERIMENT_INACTIVE` naming the required experiments when the components
	 * module is unavailable — either Elementor (or a pre-components Elementor) is missing the module
	 * classes, or one of the gating experiments is off. Mirrors `Module::is_experiment_active()`.
	 *
	 * @return true|WP_Error
	 */
	/**
	 * Entitlement guard — MIRRORS Elementor's own commercial tiering for the components module
	 * (`Components_Access_Controller`): create needs an ACTIVE Pro license, edit/update accepts
	 * active-or-expired. Deliberate: this controller adds the update route Elementor lacks, it does
	 * not hand out capability Elementor sells. Callers (elementor-jsx) fall back to inline expansion
	 * on 403 so builds stay portable.
	 *
	 * @param string $action 'create'|'edit'.
	 * @return true|WP_Error
	 */
	private function assert_entitled( string $action ) {
		$controller_class = '\\Elementor\\Modules\\Components\\Components_Access_Controller';
		if ( ! class_exists( $controller_class ) ) {
			return true; // No access controller on this build — assert_components_ready() already ran.
		}

		$controller = new $controller_class();
		$method     = ( 'create' === $action ) ? 'can_create' : 'can_edit';
		if ( ! method_exists( $controller, $method ) || true === $controller->$method() ) {
			return true;
		}

		return $this->fail(
			Error_Codes::PRO_REQUIRED,
			( 'create' === $action )
				? __( 'Creating Elementor components requires an active Elementor Pro license (this mirrors Elementor\'s own gate on POST elementor/v1/components). The compiler falls back to inline expansion, so the page still deploys.', 'elementor-ultra-mcp' )
				: __( 'Updating Elementor components requires an Elementor Pro license (active or expired), mirroring Elementor\'s own component editing gate.', 'elementor-ultra-mcp' ),
			403,
			array(
				'action'   => $action,
				'mirrors'  => 'Elementor\\Modules\\Components\\Components_Access_Controller::' . $method . '()',
				'fallback' => 'inline-expansion',
			)
		);
	}

	private function assert_components_ready() {
		if ( ! class_exists( '\Elementor\Plugin' )
			|| ! class_exists( '\Elementor\Modules\Components\Components_Repository' )
			|| ! class_exists( '\Elementor\Modules\Components\Documents\Component' ) ) {
			return $this->fail(
				Error_Codes::EXPERIMENT_INACTIVE,
				__( 'The Elementor components module is not available on this site (Elementor 4.2+ with the e_components + e_atomic_elements experiments is required).', 'elementor-ultra-mcp' ),
				501,
				array( 'required_experiments' => self::REQUIRED_EXPERIMENTS )
			);
		}

		$experiments = \Elementor\Plugin::$instance->experiments;
		$inactive    = array();
		foreach ( self::REQUIRED_EXPERIMENTS as $slug ) {
			if ( ! $experiments->is_feature_active( $slug ) ) {
				$inactive[] = $slug;
			}
		}

		if ( ! empty( $inactive ) ) {
			return $this->fail(
				Error_Codes::EXPERIMENT_INACTIVE,
				sprintf(
					/* translators: %s: comma-separated experiment slugs. */
					__( 'The Elementor components module is inactive — activate the required experiments: %s (Elementor → Settings → Features).', 'elementor-ultra-mcp' ),
					implode( ' + ', $inactive )
				),
				501,
				array(
					'required_experiments' => self::REQUIRED_EXPERIMENTS,
					'inactive_experiments' => $inactive,
				)
			);
		}

		return true;
	}

	/**
	 * Build a NATIVE-code `WP_Error` (Elementor's verbatim 422 codes). Deliberately NOT
	 * {@see Response::error()} — the taxonomy collapser would rewrite unknown codes to
	 * INTERNAL_ERROR and break native parity (see the file header). WordPress serializes this to
	 * `{code, message, data:{status, meta?}}` — the same wire shape Elementor's `Error_Builder` emits.
	 *
	 * @param string              $code    Elementor's native error code, verbatim.
	 * @param string              $message Human message (native wording where the native route has one).
	 * @param int                 $status  HTTP status (422 for all native validation codes).
	 * @param array<string,mixed> $meta    Native meta payload (caused_by / non_atomic_elements …).
	 */
	private function native_error( string $code, string $message, int $status, array $meta = array() ): WP_Error {
		$data = array( 'status' => $status );
		if ( ! empty( $meta ) ) {
			$data['meta'] = $meta;
		}
		return new WP_Error( $code, $message, $data );
	}

	/**
	 * Flatten the validator `messages` payload to strings — `Save_Components_Validator` can emit
	 * nested arrays; a bare `implode` would print "Array" (matching the native route would inherit
	 * that bug, so flatten first: same information, readable).
	 *
	 * @param array<int,mixed> $messages Validator messages (possibly nested).
	 * @return string[]
	 */
	private function flatten_messages( array $messages ): array {
		$out = array();
		array_walk_recursive(
			$messages,
			static function ( $message ) use ( &$out ) {
				$out[] = (string) $message;
			}
		);
		return $out;
	}
}

/*
 * --------------------------------------------------------------------------
 * Self-registration with the WP-P02 registrar (Parallelization Notes).
 * --------------------------------------------------------------------------
 * The registrar fires `elementor_ultra/rest/register` on `rest_api_init`, passing the live registrar;
 * we hand it a fresh controller instance so it registers the COMPONENTS routes without any edit to the
 * spine `class-registrar.php` / `class-plugin.php`.
 */
add_action(
	Registrar::REGISTER_ACTION,
	static function ( $registrar ) {
		if ( $registrar instanceof Registrar ) {
			$registrar->register_controller( new Components_Controller() );
		}
	}
);
