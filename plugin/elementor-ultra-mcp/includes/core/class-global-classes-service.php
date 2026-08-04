<?php
/**
 * WP-P08 — `Global_Classes_Service`: the single home of the diff-PUT / budget / order / usage logic.
 *
 * Contract authority: 10-rest-api.md §4.1 (list), §4.2 (diff-PUT NORMATIVE), §4.3 (usage), §0.12
 * (cache flush); 11-authoring-contract.md §5 (style objects), §5.1 (global vs local), §7 R7 (class
 * name / label rules); 12-error-taxonomy.md §3.3 (BUDGET_EXCEEDED, DUPLICATED_LABEL, INVALID_ORDER),
 * §3.4 (CAPABILITY_MISSING).
 *
 * All reads/writes go through Elementor's `Global_Classes_Repository` — NEVER raw `e_global_class`
 * post meta or kit class indexes (Contract 15 §3.6, Contract 11 §5.1). This service mirrors the EXACT
 * `final_item_ids`/budget/order/duplicate-label semantics of Elementor's own
 * `modules/global-classes/global-classes-rest-api.php` (`:331-341` budget, `:366-372` order,
 * `:382-387` duplicate-label) so the companion PUT behaves identically while attaching OUR envelope and
 * triggering the in-process cache flush.
 *
 * SPIKE-VERIFIED CORRECTIONS:
 *  - [S05] The cap that gates writes is the literal `elementor_global_classes_update_class`
 *    (`Modules\GlobalClasses\Database\Migrations\Add_Capabilities::UPDATE_CLASS`). The gate is enforced
 *    at the CONTROLLER `permission_callback` ({@see \Elementor\Ultra\Rest\Permissions::can_update_class});
 *    this service never re-checks it.
 *  - [S07/C6/R2] After EVERY write the controller flushes CSS in-process via
 *    {@see \Elementor\Ultra\Core\Cache_Service::flush_design_system()} and asserts the CSS dir is empty.
 *  - [S02/R6] Deleting a global class fires Elementor's `Global_Classes_Cleanup` which rewrites EVERY
 *    document's `_elementor_data`; the controller therefore treats a delete as a GLOBAL mutation (full
 *    flush + best-effort re-prime of dependents). This service flags a delete via {@see apply_diff}'s
 *    return so the controller can react.
 *
 * Reused by WP-P09's `design/deploy` (which applies classes + variables together) — `apply_diff` and
 * `preflight_budget` live here exactly once so that WP never duplicates the diff logic.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Core;

use Elementor\Ultra\Error_Codes;
use WP_Error;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Stateless service over the Elementor `Global_Classes_Repository` implementing list / diff-PUT /
 * usage. Returns plain arrays (or a taxonomy {@see WP_Error}) so the controller just envelopes them.
 */
final class Global_Classes_Service {

	/** Maximum global classes per install (mirrors `Global_Classes_REST_API::MAX_ITEMS`, rest-api.php:21). */
	const MAX_ITEMS = 1000;

	/** Frontend context (published variant data) — mirrors `Global_Classes_Repository::CONTEXT_FRONTEND`. */
	const CONTEXT_FRONTEND = 'frontend';

	/** Preview context (draft variant data) — mirrors `Global_Classes_Repository::CONTEXT_PREVIEW`. */
	const CONTEXT_PREVIEW = 'preview';

	/** Repository FQCN (guarded — Elementor may be unavailable in a degraded build / unit env). */
	const REPOSITORY_CLASS = '\Elementor\Modules\GlobalClasses\Global_Classes_Repository';

	/** Usage collector FQCN (guarded). */
	const USAGE_CLASS = '\Elementor\Modules\GlobalClasses\Usage\Applied_Global_Classes_Usage';

	/**
	 * List global classes (Contract 10 §4.1): the repository's full `items` map + the FULL `order` array.
	 *
	 * The controller paginates `items` but ALWAYS returns the complete `order` (a paged client still
	 * needs every id to build a consistent diff-PUT). `$context` selects the frontend (published) vs
	 * preview (draft) variant data.
	 *
	 * @param string $context `frontend` (default) or `preview`.
	 * @return array{items:array<string,array<string,mixed>>,order:string[]}|WP_Error
	 */
	public function list( string $context = self::CONTEXT_FRONTEND ) {
		$repository = $this->repository( $context );
		if ( $repository instanceof WP_Error ) {
			return $repository;
		}

		// Global_Classes::get() returns the items map keyed by id plus the full ordered id list.
		$snapshot = $repository->all()->get();

		$items = isset( $snapshot['items'] ) && is_array( $snapshot['items'] ) ? $snapshot['items'] : array();
		$order = isset( $snapshot['order'] ) && is_array( $snapshot['order'] ) ? array_values( $snapshot['order'] ) : array();

		return array(
			'items' => $items,
			'order' => $order,
		);
	}

	/**
	 * Apply the NORMATIVE diff-PUT (Contract 10 §4.2). Validates the request shape, pre-flights the
	 * budget + order, style-schema-PARSES the touched items (persisting the parsed/sanitized output —
	 * mirroring Elementor's own REST — never the raw client items), calls the repository's
	 * `apply_changes()` (NOT `put()`), and surfaces any Elementor duplicate-label rename as the SOFT
	 * outcome `modified_labels` (200, not an error — Contract 12 §3.3).
	 *
	 * The returned `meta.deleted_ids` is non-empty when the diff deletes classes, so the controller can
	 * treat the write as a GLOBAL mutation per [S02/R6] (full flush + re-prime dependents).
	 *
	 * @param array<string,mixed> $body The validated PUT body
	 *                                   (`{context,changes:{added,deleted,modified,order},items,order,op_id}`).
	 * @return array{ok:bool,modified_labels:array<string,array<string,string>>,order:string[],total:int,meta:array<string,mixed>}|WP_Error
	 */
	public function apply_diff( array $body ) {
		$context = $this->read_context( $body );
		$changes = isset( $body['changes'] ) && is_array( $body['changes'] ) ? $body['changes'] : array();

		$added    = $this->id_list( $changes['added'] ?? array() );
		$deleted  = $this->id_list( $changes['deleted'] ?? array() );
		$modified = $this->id_list( $changes['modified'] ?? array() );
		$order_in = $this->id_list( $body['order'] ?? array() );
		$items_in = isset( $body['items'] ) && is_array( $body['items'] ) ? $body['items'] : array();

		$repository = $this->repository( $context );
		if ( $repository instanceof WP_Error ) {
			return $repository;
		}

		// Existing label map (id => label) for budget + order + duplicate-label computation.
		$existing_labels = $repository->all_labels();
		$existing_ids    = array_keys( $existing_labels );

		// (a) Budget pre-flight (Contract 10 §4.2; rest-api.php:331-341). Applies NOTHING on failure.
		$budget = $this->preflight_budget_counts( count( $existing_ids ), count( $deleted ), count( $added ) );
		if ( $budget instanceof WP_Error ) {
			return $budget;
		}

		// (c) `items` keys must be a subset of (added ∪ modified) — reject extras (Contract 10 §4.2 NORMATIVE).
		$touched_allowed = array_fill_keys( array_merge( $added, $modified ), true );
		$extra_item_ids  = array();
		foreach ( array_keys( $items_in ) as $item_id ) {
			if ( ! isset( $touched_allowed[ (string) $item_id ] ) ) {
				$extra_item_ids[] = (string) $item_id;
			}
		}
		if ( ! empty( $extra_item_ids ) ) {
			return $this->error(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'items may only contain ids listed in changes.added or changes.modified (touched-only); remove the extra ids.', 'elementor-ultra-mcp' ),
				400,
				array(
					'path'      => 'items',
					'extra_ids' => array_values( $extra_item_ids ),
					'allowed'   => array_values( array_keys( $touched_allowed ) ),
				)
			);
		}

		// (e) Label rules (Contract 11 §7 R7) on every touched item that carries a label.
		$label_error = $this->validate_labels( $items_in );
		if ( $label_error instanceof WP_Error ) {
			return $label_error;
		}

		// (d) Variant validation + PARSE (Contract 11 §8 R8) — style-schema-parse each touched item and
		// keep the PARSED/sanitized parser output, which is what Elementor's own REST persists
		// (global-classes-rest-api.php:320-329 `$items_result->unwrap()`) — NEVER the raw client items.
		// Also rejects items whose key mismatches their sanitized `id` and unknown prop keys (which the
		// parser would silently strip so they never render).
		$touched_items = $this->parse_touched_items( $items_in );
		if ( $touched_items instanceof WP_Error ) {
			return $touched_items;
		}

		// Duplicate-label detection + auto-rename, mirroring rest-api.php:382-387 exactly so our soft
		// outcome matches Elementor's. Falls back to a no-rename pass when the parser is unavailable.
		$modified_labels = $this->detect_and_apply_duplicate_renames( $existing_labels, $deleted, $touched_items, $added );

		// final_item_ids = existing − deleted + added (rest-api.php merge_touched_with_existing_labels).
		$final_item_ids = $this->final_item_ids( $existing_ids, $deleted, $touched_items );

		// (b) Order consistency: top-level `order` must equal final_item_ids as a SET (rest-api.php:366-372).
		$order_error = $this->assert_order_consistent( $order_in, $final_item_ids );
		if ( $order_error instanceof WP_Error ) {
			return $order_error;
		}

		// (f) Apply via the repository (NOT put() — Contract 10 §4.2 / Implementation Notes).
		$repo_changes = array(
			'added'    => $added,
			'deleted'  => $deleted,
			'modified' => $modified,
			'order'    => isset( $changes['order'] ) && $changes['order'],
		);

		try {
			$repository->apply_changes( $touched_items, $repo_changes, $order_in );
		} catch ( \Throwable $e ) {
			return $this->error(
				Error_Codes::UPSTREAM_ERROR,
				sprintf(
					/* translators: %s: the upstream error message. */
					__( 'Applying the global-class diff failed: %s', 'elementor-ultra-mcp' ),
					$e->getMessage()
				),
				502,
				array( 'upstream' => 'Global_Classes_Repository::apply_changes' )
			);
		}

		return array(
			'ok'              => true,
			'modified_labels' => $modified_labels,
			'order'           => array_values( $order_in ),
			'total'           => count( $final_item_ids ),
			// Controller-only signal: a non-empty deleted list is a GLOBAL mutation ([S02/R6]).
			'meta'            => array(
				'deleted_ids' => array_values( $deleted ),
				'added_ids'   => array_values( $added ),
			),
		);
	}

	/**
	 * Budget pre-flight (Contract 10 §4.2; rest-api.php:331-341): `count(existing) − deleted + added`
	 * MUST be `≤ MAX_ITEMS`, else `BUDGET_EXCEEDED` and NOTHING is applied. Public so WP-P09's deploy
	 * can pre-flight BOTH budgets before applying either (all-or-nothing).
	 *
	 * @param array<string,mixed> $body The diff-PUT body (`changes.added`/`changes.deleted` read).
	 * @return true|WP_Error
	 */
	public function preflight_budget( array $body ) {
		$context = $this->read_context( $body );
		$changes = isset( $body['changes'] ) && is_array( $body['changes'] ) ? $body['changes'] : array();
		$added   = $this->id_list( $changes['added'] ?? array() );
		$deleted = $this->id_list( $changes['deleted'] ?? array() );

		$repository = $this->repository( $context );
		if ( $repository instanceof WP_Error ) {
			return $repository;
		}

		$existing_count = count( $repository->all_labels() );

		$result = $this->preflight_budget_counts( $existing_count, count( $deleted ), count( $added ) );
		return $result instanceof WP_Error ? $result : true;
	}

	/**
	 * Usage lookup (Contract 10 §4.3): `{id:{total,pages:[{post_id,count}]}}`. Transforms Elementor's
	 * `Applied_Global_Classes_Usage::get_detailed_usage()` (`{id:[{pageId,title,type,total,elements}]}`)
	 * into the contract shape.
	 *
	 * @param string $context `frontend` (default) or `preview` (kept for parity; usage is global).
	 * @return array{usage:array<string,array{total:int,pages:array<int,array{post_id:int,count:int}>}>}|WP_Error
	 */
	public function usage( string $context = self::CONTEXT_FRONTEND ) {
		unset( $context ); // Usage is collected across ALL documents; context is informational only.

		if ( ! class_exists( self::USAGE_CLASS ) ) {
			return $this->error(
				Error_Codes::UPSTREAM_ERROR,
				__( 'Elementor global-class usage is unavailable (the global-classes module is not loaded).', 'elementor-ultra-mcp' ),
				502,
				array( 'missing' => self::USAGE_CLASS )
			);
		}

		$usage_class = self::USAGE_CLASS;

		try {
			$detailed = ( new $usage_class() )->get_detailed_usage();
		} catch ( \Throwable $e ) {
			return $this->error(
				Error_Codes::UPSTREAM_ERROR,
				sprintf(
					/* translators: %s: the upstream error message. */
					__( 'Collecting global-class usage failed: %s', 'elementor-ultra-mcp' ),
					$e->getMessage()
				),
				502
			);
		}

		$usage = array();
		foreach ( (array) $detailed as $class_id => $pages ) {
			$total     = 0;
			$page_rows = array();
			foreach ( (array) $pages as $page ) {
				$post_id     = isset( $page['pageId'] ) ? (int) $page['pageId'] : 0;
				$count       = isset( $page['total'] ) ? (int) $page['total'] : 0;
				$total      += $count;
				$page_rows[] = array(
					'post_id' => $post_id,
					'count'   => $count,
				);
			}
			$usage[ (string) $class_id ] = array(
				'total' => $total,
				'pages' => $page_rows,
			);
		}

		return array( 'usage' => $usage );
	}

	// ---------------------------------------------------------------------
	// Internals.
	// ---------------------------------------------------------------------

	/**
	 * Resolve a `Global_Classes_Repository` bound to the active kit + the requested preview context.
	 *
	 * @param string $context `frontend`|`preview`.
	 * @return object|WP_Error The repository, or UPSTREAM_ERROR when the module/kit is unavailable.
	 */
	private function repository( string $context ) {
		if ( ! class_exists( self::REPOSITORY_CLASS ) ) {
			return $this->error(
				Error_Codes::UPSTREAM_ERROR,
				__( 'Elementor global classes are unavailable (the global-classes module is not loaded).', 'elementor-ultra-mcp' ),
				502,
				array( 'missing' => self::REPOSITORY_CLASS )
			);
		}

		$kit = $this->active_kit();
		if ( null === $kit ) {
			return $this->error(
				Error_Codes::UPSTREAM_ERROR,
				__( 'No active Elementor kit; global classes cannot be read or written.', 'elementor-ultra-mcp' ),
				502
			);
		}

		$repository_class = self::REPOSITORY_CLASS;
		$repository       = $repository_class::make( $kit );

		if ( self::CONTEXT_PREVIEW === $context && method_exists( $repository, 'set_preview' ) ) {
			$repository->set_preview( true );
		}

		return $repository;
	}

	/** The active Elementor kit, or null when the kits manager is unavailable. */
	private function active_kit() {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return null;
		}
		$plugin = \Elementor\Plugin::$instance;
		if ( null === $plugin || ! isset( $plugin->kits_manager ) ) {
			return null;
		}
		$manager = $plugin->kits_manager;
		if ( ! method_exists( $manager, 'get_active_kit' ) ) {
			return null;
		}
		return $manager->get_active_kit();
	}

	/**
	 * Shared budget computation (Contract 10 §4.2; rest-api.php:331-341). `current = existing − deleted
	 * + added`; over `MAX_ITEMS` → `BUDGET_EXCEEDED` (400 per the frozen taxonomy) carrying
	 * `meta.{current_count,max_allowed,kind:"classes"}`.
	 *
	 * @param int $existing Count of currently-stored classes.
	 * @param int $deleted  Count of ids being deleted.
	 * @param int $added    Count of ids being added.
	 * @return true|WP_Error
	 */
	private function preflight_budget_counts( int $existing, int $deleted, int $added ) {
		$current = $existing - $deleted + $added;

		if ( $current > self::MAX_ITEMS ) {
			return $this->error(
				Error_Codes::BUDGET_EXCEEDED,
				sprintf(
					/* translators: 1: projected count, 2: maximum allowed. */
					__( 'Global classes limit exceeded: this change would result in %1$d classes (maximum %2$d). Delete some classes first.', 'elementor-ultra-mcp' ),
					$current,
					self::MAX_ITEMS
				),
				Error_Codes::http_status( Error_Codes::BUDGET_EXCEEDED ),
				array(
					'current_count' => $current,
					'max_allowed'   => self::MAX_ITEMS,
					'kind'          => 'classes',
				)
			);
		}

		return true;
	}

	/**
	 * Compute `final_item_ids` exactly like rest-api.php's `merge_touched_with_existing_labels`: start
	 * from existing ids (skipping deleted), then append any touched-but-new ids (the added set) not yet
	 * present. Preserves insertion order so it is a stable id list.
	 *
	 * @param string[]                          $existing_ids  Currently-stored ids (in stored order).
	 * @param string[]                          $deleted       Ids being deleted.
	 * @param array<string,array<string,mixed>> $touched_items Touched items keyed by id.
	 * @return string[] The final id list (existing − deleted + added).
	 */
	private function final_item_ids( array $existing_ids, array $deleted, array $touched_items ): array {
		$deleted_set = array_fill_keys( $deleted, true );
		$final       = array();
		$seen        = array();

		foreach ( $existing_ids as $id ) {
			$id = (string) $id;
			if ( isset( $deleted_set[ $id ] ) ) {
				continue;
			}
			$final[]     = $id;
			$seen[ $id ] = true;
		}

		foreach ( array_keys( $touched_items ) as $id ) {
			$id = (string) $id;
			if ( ! isset( $seen[ $id ] ) && ! isset( $deleted_set[ $id ] ) ) {
				$final[]     = $id;
				$seen[ $id ] = true;
			}
		}

		return $final;
	}

	/**
	 * Order consistency (Contract 10 §4.2; rest-api.php:366-372): the top-level `order` MUST equal
	 * `final_item_ids` as a SET (same membership, no missing/extra ids). On mismatch → `INVALID_ORDER`
	 * (400 per the frozen taxonomy) with `meta.{expected_ids,received_ids}`.
	 *
	 * @param string[] $received       Caller-supplied full order array.
	 * @param string[] $final_item_ids Expected final id set.
	 * @return true|WP_Error
	 */
	private function assert_order_consistent( array $received, array $final_item_ids ) {
		$received_sorted = $received;
		$expected_sorted = $final_item_ids;
		sort( $received_sorted );
		sort( $expected_sorted );

		// Also catch duplicate ids in the received order (a set mismatch even if sorted lists differ in length).
		if ( $received_sorted !== $expected_sorted ) {
			return $this->error(
				Error_Codes::INVALID_ORDER,
				__( 'order must be the full final id list (existing − deleted + added); it is missing ids, has extra ids, or contains duplicates.', 'elementor-ultra-mcp' ),
				Error_Codes::http_status( Error_Codes::INVALID_ORDER ),
				array(
					'expected_ids' => array_values( $final_item_ids ),
					'received_ids' => array_values( $received ),
				)
			);
		}

		return true;
	}

	/**
	 * Duplicate-label detection + auto-rename, mirroring rest-api.php:382-387. When two touched/existing
	 * labels collide, Elementor mints a unique label and the caller MUST rebind. We mutate the touched
	 * item's label in place (so the rename is persisted) and return the `{id:{modified}}` map.
	 *
	 * Uses Elementor's own `Global_Classes_Parser::check_for_duplicate_labels` +
	 * `Global_Classes_Labels::generate_unique_label` so the rename is byte-identical to the editor. When
	 * those helpers are unavailable (degraded build), returns an empty map (no rename) — the repository
	 * still applies the diff.
	 *
	 * @param array<string,string>              $existing_labels id => label of currently-stored classes.
	 * @param string[]                          $deleted         Deleted ids.
	 * @param array<string,array<string,mixed>> $touched_items Touched items keyed by id (mutated in place).
	 * @param string[]                          $added           Added ids.
	 * @return array<string,array<string,string>> `{id:{modified:<label>}}` (empty when no rename).
	 */
	private function detect_and_apply_duplicate_renames( array $existing_labels, array $deleted, array &$touched_items, array $added ) {
		$parser_class = '\Elementor\Modules\GlobalClasses\Global_Classes_Parser';
		$labels_class = '\Elementor\Modules\GlobalClasses\Global_Classes_Labels';

		if ( ! class_exists( $parser_class ) || ! method_exists( $parser_class, 'check_for_duplicate_labels' )
			|| ! class_exists( $labels_class ) || ! method_exists( $labels_class, 'generate_unique_label' ) ) {
			return array();
		}

		try {
			$duplicates = $parser_class::check_for_duplicate_labels( $existing_labels, $deleted, $touched_items, $added );
		} catch ( \Throwable $e ) {
			unset( $e );
			return array();
		}

		if ( empty( $duplicates ) ) {
			return array();
		}

		// Existing label list (excluding deleted) seeds the uniqueness check (rest-api.php:393-404).
		$existing_label_list = array();
		foreach ( $existing_labels as $id => $label ) {
			if ( ! in_array( (string) $id, $deleted, true ) ) {
				$existing_label_list[] = $label;
			}
		}

		$modified_labels = array();
		foreach ( $duplicates as $duplicate ) {
			$item_id        = isset( $duplicate['item_id'] ) ? (string) $duplicate['item_id'] : '';
			$original_label = isset( $duplicate['label'] ) ? (string) $duplicate['label'] : '';
			if ( '' === $item_id ) {
				continue;
			}

			$new_label = $labels_class::generate_unique_label( $original_label, $existing_label_list );

			// Persist the rename onto the touched item + the running uniqueness list (rest-api.php:385-389).
			if ( isset( $touched_items[ $item_id ] ) && is_array( $touched_items[ $item_id ] ) ) {
				$touched_items[ $item_id ]['label'] = $new_label;
			}
			$existing_label_list[] = $new_label;

			$modified_labels[ $item_id ] = array( 'modified' => $new_label );
		}

		return $modified_labels;
	}

	/**
	 * Enforce the Contract 11 §7 R7 global-class label rules on every touched item that carries a
	 * `label`: 2–50 chars, no whitespace, no leading digit/`--`/`-digit`, not the reserved `container`.
	 * Returns the first failure as `SCHEMA_INVALID_PARAMS` (400) — the agent fixes the label and retries.
	 *
	 * @param array<string,mixed> $items_in Touched items keyed by id.
	 * @return true|WP_Error
	 */
	private function validate_labels( array $items_in ) {
		foreach ( $items_in as $item_id => $item ) {
			if ( ! is_array( $item ) || ! isset( $item['label'] ) ) {
				continue; // Label PRESENCE is enforced by the style parser ({@see parse_touched_items}); R7 rules apply when present.
			}
			$label = (string) $item['label'];

			$violation = $this->label_violation( $label );
			if ( null !== $violation ) {
				return $this->error(
					Error_Codes::SCHEMA_INVALID_PARAMS,
					sprintf(
						/* translators: 1: the offending label, 2: the rule that failed. */
						__( 'Invalid global-class label "%1$s": %2$s (Contract 11 §7).', 'elementor-ultra-mcp' ),
						$label,
						$violation
					),
					400,
					array(
						'path'  => 'items.' . $item_id . '.label',
						'label' => $label,
						'rule'  => $violation,
					)
				);
			}
		}

		return true;
	}

	/**
	 * Return the human description of the first label rule a label violates, or null when it is valid
	 * (Contract 11 §7 R7).
	 *
	 * @param string $label Candidate label.
	 * @return string|null
	 */
	private function label_violation( string $label ): ?string {
		$len = function_exists( 'mb_strlen' ) ? mb_strlen( $label ) : strlen( $label );

		if ( $len < 2 || $len > 50 ) {
			return __( 'must be 2–50 characters', 'elementor-ultra-mcp' );
		}
		if ( preg_match( '/\s/', $label ) ) {
			return __( 'must not contain spaces or whitespace', 'elementor-ultra-mcp' );
		}
		if ( 'container' === $label ) {
			return __( 'must not be the reserved name "container"', 'elementor-ultra-mcp' );
		}
		// No leading digit, no leading `--`, no leading `-<digit>`.
		if ( preg_match( '/^[0-9]/', $label ) ) {
			return __( 'must not start with a digit', 'elementor-ultra-mcp' );
		}
		if ( 0 === strpos( $label, '--' ) ) {
			return __( 'must not start with "--"', 'elementor-ultra-mcp' );
		}
		if ( preg_match( '/^-[0-9]/', $label ) ) {
			return __( 'must not start with "-" followed by a digit', 'elementor-ultra-mcp' );
		}

		return null;
	}

	/**
	 * Style-schema-PARSE every touched item's style object (Contract 11 §8 R8) using Elementor's
	 * authoritative `Style_Parser::make( Style_Schema::get() )->parse( $item )` — the SAME parser
	 * Elementor's own `Global_Classes_Parser::parse_items` runs per item and the SAME parser the
	 * {@see \Elementor\Ultra\Validator} uses for per-style verdicts. A global class IS a class style
	 * definition `{id,label,type:'class',variants:[{meta,props}]}` (Contract 11 §5); the parser validates
	 * the whole envelope INCLUDING each `variants[].props` against the live `Style_Schema`.
	 *
	 * Returns the PARSED/SANITIZED items keyed by id — what Elementor's own REST persists via
	 * `$items_result->unwrap()` (global-classes-rest-api.php:320-329): `sanitize_key`'d id,
	 * `sanitize_text_field`'d label, normalized `custom_css.raw` (decode → sanitize → re-encode) and
	 * `Props_Parser`-sanitized props. NEVER returns the raw client items (persisting those verbatim
	 * stored junk Elementor never renders — read-backs showed phantom props that silently had no effect).
	 *
	 * Hard rejects (422 `ATOMIC_STYLES_INVALID` with per-item errors; the diff is NOT applied):
	 *  - a parse failure (invalid envelope / variant props);
	 *  - an item key that mismatches its sanitized `item['id']` (upstream `mismatching_value`,
	 *    global-classes-parser.php:96-100);
	 *  - UNKNOWN prop keys: `Props_Parser::validate` iterates SCHEMA KEYS ONLY (props-parser.php:29-54),
	 *    so a typo'd/unmapped key passes validation but is silently stripped by `parse()` and never
	 *    renders. Upstream strips silently (invisible drop); we reject loudly so agents learn about the
	 *    dropped prop instead of getting a 200 for style data that never takes effect.
	 *
	 * When the parser is unavailable (degraded build) the raw items are passed through unchanged (the
	 * repository still validates server-side).
	 *
	 * @param array<string,mixed> $items_in Touched items keyed by id.
	 * @return array<string,array<string,mixed>>|WP_Error Parsed items keyed by id, or the 422.
	 */
	private function parse_touched_items( array $items_in ) {
		$parser_class = '\Elementor\Modules\AtomicWidgets\Parsers\Style_Parser';
		$schema_class = '\Elementor\Modules\AtomicWidgets\Styles\Style_Schema';

		// Normalized raw map (also the degraded-build fallback when the parser is unavailable).
		$raw_items = array();
		foreach ( $items_in as $item_id => $item ) {
			if ( is_array( $item ) ) {
				$raw_items[ (string) $item_id ] = $item;
			}
		}

		if ( ! class_exists( $parser_class ) || ! class_exists( $schema_class )
			|| ! method_exists( $parser_class, 'make' ) || ! method_exists( $schema_class, 'get' ) ) {
			return $raw_items;
		}

		try {
			$schema = $schema_class::get();
		} catch ( \Throwable $e ) {
			return $raw_items; // Schema unavailable — defer to the repository's own validation.
		}

		$schema_keys  = is_array( $schema ) ? array_fill_keys( array_map( 'strval', array_keys( $schema ) ), true ) : array();
		$errors       = array();
		$parsed_items = array();

		foreach ( $raw_items as $item_id => $item ) {
			// Unknown prop keys → HARD reject (see docblock; collected per variant so the agent sees them all).
			foreach ( $this->unknown_prop_keys( $item, $schema_keys ) as $variant_index => $unknown_keys ) {
				$errors[] = array(
					'path'    => 'items.' . $item_id . '.variants[' . $variant_index . '].props',
					'code'    => Error_Codes::ATOMIC_STYLES_INVALID,
					'message' => sprintf(
						/* translators: %s: comma-separated list of unknown prop keys. */
						__( 'Unknown style prop key(s) not in the live style schema: %s. Elementor silently strips unknown props so they NEVER render — remove or remap them.', 'elementor-ultra-mcp' ),
						implode( ', ', $unknown_keys )
					),
					'meta'    => array(
						'class_id'     => (string) $item_id,
						'unknown_keys' => array_values( $unknown_keys ),
					),
				);
			}

			try {
				// Parse the FULL style definition (id/type/label/variants) — mirrors Global_Classes_Parser::parse_items.
				$result = $parser_class::make( $schema )->parse( $item );
			} catch ( \Throwable $e ) {
				$errors[] = array(
					'path'    => 'items.' . $item_id,
					'code'    => Error_Codes::ATOMIC_STYLES_INVALID,
					'message' => $e->getMessage(),
					'meta'    => array( 'class_id' => (string) $item_id ),
				);
				continue;
			}

			if ( $result && method_exists( $result, 'is_valid' ) && ! $result->is_valid() ) {
				$detail = '';
				if ( method_exists( $result, 'errors' ) ) {
					$err_bag = $result->errors();
					if ( is_object( $err_bag ) && method_exists( $err_bag, 'to_string' ) ) {
						$detail = (string) $err_bag->to_string();
					}
				}
				$errors[] = array(
					'path'    => 'items.' . $item_id,
					'code'    => Error_Codes::ATOMIC_STYLES_INVALID,
					'message' => '' !== $detail ? $detail : __( 'Style object / variant props failed style-schema validation.', 'elementor-ultra-mcp' ),
					'meta'    => array( 'class_id' => (string) $item_id ),
				);
				continue;
			}

			// Keep the PARSED/sanitized item — rest-api.php:329 `$items_result->unwrap()` equivalent.
			$sanitized = ( $result && method_exists( $result, 'unwrap' ) ) ? $result->unwrap() : null;
			if ( ! is_array( $sanitized ) ) {
				$parsed_items[ $item_id ] = $item; // Defensive: parser yielded no payload — keep the raw item.
				continue;
			}

			// Item key MUST match the sanitized id (global-classes-parser.php:96-100 `mismatching_value`).
			$sanitized_id = isset( $sanitized['id'] ) ? (string) $sanitized['id'] : '';
			if ( $item_id !== $sanitized_id ) {
				$errors[] = array(
					'path'    => 'items.' . $item_id . '.id',
					'code'    => Error_Codes::ATOMIC_STYLES_INVALID,
					'message' => sprintf(
						/* translators: 1: the items map key, 2: the sanitized item id. */
						__( 'Item key "%1$s" does not match its sanitized id "%2$s" (mismatching_value). Key the item by its own id (lowercase alphanumeric/dash/underscore).', 'elementor-ultra-mcp' ),
						$item_id,
						$sanitized_id
					),
					'meta'    => array(
						'class_id'     => (string) $item_id,
						'sanitized_id' => $sanitized_id,
					),
				);
				continue;
			}

			$parsed_items[ $item_id ] = $sanitized;
		}

		if ( ! empty( $errors ) ) {
			return $this->error(
				Error_Codes::ATOMIC_STYLES_INVALID,
				__( 'One or more global-class items have invalid style props, mismatched ids, or unknown prop keys; fix them and retry. The diff was NOT applied.', 'elementor-ultra-mcp' ),
				Error_Codes::http_status( Error_Codes::ATOMIC_STYLES_INVALID ),
				array( 'kind' => 'classes' ),
				$errors
			);
		}

		return $parsed_items;
	}

	/**
	 * Collect prop keys that are NOT in the live style schema, per variant index. These pass
	 * `Props_Parser::validate` (it iterates schema keys only) yet are stripped by `parse()` — i.e. they
	 * would be silently dropped. Returns `{<variant_index>: [<key>, ...]}` (empty when all keys are known
	 * or the schema/variants are unavailable).
	 *
	 * @param array<string,mixed> $item        A touched style item (`{id,label,type,variants}`).
	 * @param array<string,bool>  $schema_keys Style-schema prop keys as a set.
	 * @return array<int|string,string[]>
	 */
	private function unknown_prop_keys( array $item, array $schema_keys ): array {
		$out = array();

		if ( empty( $schema_keys ) || ! isset( $item['variants'] ) || ! is_array( $item['variants'] ) ) {
			return $out;
		}

		foreach ( $item['variants'] as $variant_index => $variant ) {
			if ( ! is_array( $variant ) || ! isset( $variant['props'] ) || ! is_array( $variant['props'] ) ) {
				continue;
			}
			$unknown = array();
			foreach ( array_keys( $variant['props'] ) as $prop_key ) {
				if ( ! isset( $schema_keys[ (string) $prop_key ] ) ) {
					$unknown[] = (string) $prop_key;
				}
			}
			if ( ! empty( $unknown ) ) {
				$out[ $variant_index ] = $unknown;
			}
		}

		return $out;
	}

	/**
	 * Read + normalize the `context` field of a body to `frontend`|`preview` (default `frontend`).
	 *
	 * @param array<string,mixed> $body The request body.
	 */
	private function read_context( array $body ): string {
		$context = isset( $body['context'] ) ? (string) $body['context'] : self::CONTEXT_FRONTEND;
		return self::CONTEXT_PREVIEW === $context ? self::CONTEXT_PREVIEW : self::CONTEXT_FRONTEND;
	}

	/**
	 * Coerce an arbitrary value into a clean list of non-empty string ids (defensive against scalar /
	 * malformed `changes.*` arrays).
	 *
	 * @param mixed $value Raw id list.
	 * @return string[]
	 */
	private function id_list( $value ): array {
		if ( ! is_array( $value ) ) {
			return array();
		}
		$out = array();
		foreach ( $value as $id ) {
			if ( is_string( $id ) && '' !== $id ) {
				$out[] = $id;
			} elseif ( is_int( $id ) ) {
				$out[] = (string) $id;
			}
		}
		return $out;
	}

	/**
	 * Mint a taxonomy `WP_Error` via the shared {@see Error} factory (so the `data` block matches §0.6).
	 *
	 * @param string                         $code    Taxonomy code.
	 * @param string                         $message Human, actionable message.
	 * @param int                            $status  HTTP status.
	 * @param array<string,mixed>            $meta    Structured context.
	 * @param array<int,array<string,mixed>> $errors  Per-item validation errors.
	 */
	private function error( string $code, string $message, int $status, array $meta = array(), array $errors = array() ): WP_Error {
		return Error::make( $code, $message, $status, $meta, $errors );
	}
}
