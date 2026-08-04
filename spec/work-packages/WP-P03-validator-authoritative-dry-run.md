---
id: WP-P03
title: Validator core — the AUTHORITATIVE dry_run element-tree validator
layer: php
phase: MVP
status: planned
depends_on: [WP-P01, WP-P02, WP-F03, WP-F05]
files_owned:
  - plugin/elementor-ultra-mcp/includes/core/class-validator.php
  - plugin/elementor-ultra-mcp/includes/core/class-diff-builder.php
contract_refs:
  - spec/contracts/10-rest-api.md §0.9 (dry-run-before-commit), §2.3 (dry-run route payload)
  - spec/contracts/11-authoring-contract.md §3 (typed envelope), §5 (styles), §8 (validation rules R1-R9)
  - spec/contracts/12-error-taxonomy.md §3.1 (validation codes), §4 (no string-match)
  - spec/contracts/14-fixtures-harness.md §3 (round-trip through dry_run)
estimate: L
---

## Summary

The single source of truth for element-tree validity. `Validator::dry_run()` instantiates every authoring node via Elementor's `create_element_instance()` + `get_data_for_save()` inside a try/catch, classifies any caught atomic save throw into structured taxonomy errors WITHOUT string-matching Elementor's messages, and returns a `DryRunResult` (valid flag + `errors[]` + diff + detected generation + id collisions). Every WRITE route in the plugin calls this BEFORE persisting; nothing is persisted on failure. This WP is the most safety-critical PHP module (it is the authoritative half of the locked "PHP dry_run is authoritative, TS prefilter is a pre-filter only" decision).

## Interface / Contract

- `\Elementor\Ultra\Core\Validator`:
  - `dry_run( array $elements, array $settings = [], int $post_id = 0, string $generation_hint = 'auto' ): array` — returns a `DryRunResult`-shaped assoc array (Contract 11 schema `diff.schema.json#/$defs/DryRunResult`):
    ```
    {
      valid: bool,
      errors: [ { path, code, message, meta } ],   // code ∈ Contract 12 §3.1
      diff: { changed_ids, new_ids, removed_ids, before:{id:node}, after:{id:node} },
      id_collisions: [ "<id>" ],
      generation_detected: "v4"|"v3"|"mixed",
      preview_url: null
    }
    ```
  - `validate_only( array $elements, array $settings = [] ): array{ valid, errors }` — the validation half without diff (used by `save`/`replace-tree`/`elements`/`templates` controllers internally before persisting, Contract 10 §0.9).
  - `detect_generation( array $node ): "v4"|"v3"` — per-node (atomic `e-*`/typed-envelope vs classic flat settings).
- `\Elementor\Ultra\Core\Diff_Builder`:
  - `build( ?array $before_elements, array $after_elements ): array` — the `diff` block above; flattens trees to `{id => node}` maps and computes `changed_ids/new_ids/removed_ids`. `before` null ⇒ everything is new.
- `DryRunResult.errors[].path` is a JSON-pointer-like dotted path into the request body (`elements[2].settings.title`, `elements[0].styles.e-abc-7f3a.variants[0].props.display`), per Contract 10 §2.3.

## Dependencies & Inputs

- WP-P01 (`Guards` to know if atomic is available), WP-P02 (`Error` factory / `Error::from_atomic_exception` formatting helper — this WP supplies the phase context so it never string-matches).
- WP-F03: the authoring JSON schemas + TS type names. The PHP validator does NOT consume the TS types but its `DryRunResult`/`Diff`/`ValidationError` output MUST match `spec/contracts/schemas/diff.schema.json` exactly (the fixtures harness asserts both sides agree).
- WP-F05: taxonomy codes (`ATOMIC_SETTINGS_INVALID`, `ATOMIC_STYLES_INVALID`, `UNKNOWN_WIDGET_TYPE`, `DUPLICATE_ELEMENT_ID`, `LOCAL_STYLE_UNLINKED`, `IMAGE_SRC_XOR_VIOLATION`, `VALIDATION_FAILED`).
- Elementor APIs (cite `path:line`):
  - `\Elementor\Plugin::$instance->elements_manager->create_element_instance( $element_data )` — instantiates a node; throws/returns null on unknown atomic types.
  - `Element_Base::get_data_for_save()` and the atomic base `get_data_for_save()` at `modules/atomic-widgets/base/has-atomic-base.php:88-117` — this is where `Props_Parser`/`Style_Parser` throw `\Exception` with "Settings validation failed." (`:113`) and "Styles validation failed for style `<id>`. Widget ID: `<id>`. " (`:97`). The validator catches these and classifies by the phase context, never by message text.
  - `\Elementor\Plugin::$instance->widgets_manager->get_widget_types()` / `elements_manager->get_element_types()` for registered-type checks (Contract 11 R2).
  - `image-src-prop-type.php:36-44` (id-XOR-url) — the validator should pre-flag IMAGE_SRC_XOR_VIOLATION structurally where cheap, but the authoritative verdict still comes from the instantiate-throw path.
- Contract 11 §8 validation rules R1–R9 (R2/R5/R8 are PHP-authoritative; R1/R3/R4/R7/R9 are structurally checkable).
- Contract 14 §3 (the fixtures round-trip protocol this validator must satisfy: `valid` + error-code set).

## Detailed Requirements

1. **Instantiate-and-catch loop** (Contract 10 §2.3, §0.9): for each node (recursively), call `create_element_instance($node)` then `get_data_for_save()` inside `try { ... } catch ( \Exception $e ) { ... }`. Capture which node id was being processed (`meta.throwing_widget_id`) and which PHASE (settings vs styles) — determined by which method threw / by inspecting the atomic base flow context, NOT by reading `$e->getMessage()`.
2. **Classify throws** (Contract 12 §4, Contract 11 §3): a settings-phase throw ⇒ `ATOMIC_SETTINGS_INVALID` with `meta.element_id`, `meta.prop` (if extractable from context), `meta.parser_errors` = raw appended text. A styles-phase throw ⇒ `ATOMIC_STYLES_INVALID` with `meta.element_id`, `meta.style_id`, `meta.parser_errors`. The raw Elementor message is copied verbatim into `meta.parser_errors` and appended to the human `message`; it is NEVER used as the `code`.
3. **Unknown types** (Contract 11 R2, Contract 12 `UNKNOWN_WIDGET_TYPE`): atomic `e-*` types not registered ⇒ `create_element_instance` returns null / throws ⇒ emit `UNKNOWN_WIDGET_TYPE` error (atomic nodes THROW on a real save). Legacy classic `widgetType` not registered ⇒ emit `UNKNOWN_WIDGET_TYPE` as a WARNING-tier error (they would be silently DROPPED on a real save — note this in `meta.silently_dropped:true`) so the agent knows. Check against `schema/registered-types` data (reuse the registered-type lists from WP-P07's helper if available, else compute locally via the managers).
4. **ID uniqueness** (Contract 11 R3, Contract 12 `DUPLICATE_ELEMENT_ID`): walk the whole tree, collect `id`s; any duplicate within the tree ⇒ `DUPLICATE_ELEMENT_ID` error and an entry in `id_collisions[]`. When `post_id>0`, also compare against the existing document's used-id set (the validator may call WP-P04's `Id_Service::used_ids($post_id)` if available; otherwise read `_elementor_data` and flatten).
5. **Local-style mirroring** (Contract 11 §5.1, R4, Contract 12 `LOCAL_STYLE_UNLINKED`): for every atomic node, every key in `styles` map MUST appear in that node's `settings.classes.value` array; a `styles` id absent from `classes` ⇒ `LOCAL_STYLE_UNLINKED` error (would silently detach). Also flag duplicate local-style ids across the tree.
6. **image-src XOR** (Contract 11 §3.2, R9, Contract 12 `IMAGE_SRC_XOR_VIOLATION`): structurally detect an `image-src` value that has both `id` and `url` or neither ⇒ `IMAGE_SRC_XOR_VIOLATION` with `meta.element_id`, `meta.prop`. (The instantiate path also catches this; the structural check gives a precise path/code.)
7. **R1 structural**: every node has non-empty `id` (string) and `elType`; missing ⇒ `VALIDATION_FAILED` with the offending path.
8. **Generation detection**: `detect_generation` per node; `generation_detected` is `v4` if all atomic, `v3` if all classic, else `mixed`. The `generation_hint` arg only biases ambiguous cases; per-node detection always wins (Contract 11 R6).
9. **Diff**: when `post_id>0`, read the existing tree as `before`; build `diff` via `Diff_Builder`. When `post_id==0`, `before` is empty and all nodes are `new_ids`. Diff is computed AFTER id minting/dedupe would occur — but `dry_run` itself does NOT mint ids (that is WP-P04's job and happens on save); for dry-run the diff uses the ids as-authored, and `id_collisions` reports what would need remapping.
10. **No persistence** (Contract 10 §2.3, §0.9): `dry_run`/`validate_only` MUST NOT write any post meta, must not create posts, must not regenerate CSS. The instantiate path is read-only by construction; assert this with a test that meta is unchanged after a dry-run.
11. **`want_preview` is NOT this WP's concern**: the dry-run ROUTE (WP-P06) handles `want_preview` (autosave + preview_url). `Validator` returns `preview_url:null` always; the controller fills it.
12. **Error aggregation**: collect ALL detectable errors (do not stop at the first) for structural checks; for the instantiate-throw path, Elementor aborts the whole save on the first bad prop, so capture that one throw per node but continue to the next node so the agent sees as many problems as possible per pass. `valid = empty(errors)` (warnings with `meta.silently_dropped` still count as errors per the contract's strict stance, EXCEPT `HTML_V3_STRIPPED` which is soft and not produced here — that is the converter's job).

## Implementation Notes

- The atomic throw site is `modules/atomic-widgets/base/has-atomic-base.php:88-117`: styles validation throws at `:95-98` ("Styles validation failed for style `%s`. Widget ID: `%s`."), settings at `:113` ("Settings validation failed."). The phase is known by WHERE in the flow you are when the exception bubbles — wrap settings and styles validation in separate try blocks if the base exposes them separately; otherwise wrap the single `get_data_for_save()` and use the presence of a `style_id` token in the structured Elementor error object (NOT the message) to disambiguate. If neither is available, fall back to `ATOMIC_SETTINGS_INVALID` and put the raw text in `parser_errors` (still no message-string matching for control flow).
- `create_element_instance` for an unregistered atomic type may emit a PHP notice and return null — guard with the registered-type set first to produce a clean `UNKNOWN_WIDGET_TYPE` rather than relying on a null return.
- Be defensive: the authoring tree comes from the wire. Coerce types carefully; a malformed node (e.g. `settings` not an array) ⇒ `VALIDATION_FAILED` with path, not a PHP fatal.
- The `before` tree for diff comes from `get_post_meta($post_id,'_elementor_data',true)` (json-decoded) — do not instantiate it (the existing tree is assumed already valid; instantiating it would be slow and could spuriously throw on Elementor-version drift).
- This validator is reused by `save`, `replace-tree`, `elements`, `templates.save`, `templates.insert`, and the Pro/batch WPs. Keep `validate_only` fast and side-effect-free so write controllers can call it on the hot path.
- Do NOT depend on WP-P04 at the code level for the basic path (so it can be built first); the optional `Id_Service::used_ids` call is behind a `class_exists`/method check. The contract dependency on WP-P04 is satisfied by the writer calling the validator, not vice versa.

## Acceptance Criteria

- [ ] `dry_run` of a valid atomic tree returns `valid:true`, `errors:[]`, and a correct `diff`/`generation_detected`.
- [ ] `dry_run` of an atomic tree with a bad `tag` enum returns `valid:false` with an error whose `code` is `ATOMIC_SETTINGS_INVALID` and whose `meta.parser_errors` contains Elementor's raw text — and the `code` is NEVER the raw throw string.
- [ ] A style id present in `styles` but absent from `classes` yields `LOCAL_STYLE_UNLINKED` with the right `element_id`/`style_id`.
- [ ] An `image-src` with both `id` and `url` yields `IMAGE_SRC_XOR_VIOLATION`.
- [ ] Duplicate ids across the tree yield `DUPLICATE_ELEMENT_ID` and populate `id_collisions[]`.
- [ ] An unregistered atomic `e-*` type yields `UNKNOWN_WIDGET_TYPE`; an unregistered classic `widgetType` yields `UNKNOWN_WIDGET_TYPE` with `meta.silently_dropped:true`.
- [ ] `dry_run` writes NOTHING: post meta, CSS files, and revisions are unchanged afterward (asserted).
- [ ] Every fixture under `packages/shared/fixtures/trees/**` produces `valid` and an error-code SET exactly matching the fixture's `expect` (Contract 14 §3) — this is the gating acceptance test.
- [ ] Output validates against `spec/contracts/schemas/diff.schema.json#/$defs/DryRunResult`.
- [ ] PHPCS clean.

## Tests Required

- PHPUnit (wp-env, Contract 14 §3): the full `trees/**` corpus round-trip (`valid` + error-code set, order-independent). This is the authoritative fixture suite.
- Unit-ish PHPUnit: `test_dry_run_no_side_effects` (meta/CSS/revisions unchanged); `test_classify_settings_vs_styles_throw_without_string_match`; `test_diff_changed_new_removed`; `test_generation_detection_mixed_tree`; `test_local_style_unlinked`; `test_image_src_xor`; `test_duplicate_ids`.
- Provide at minimum these invalid fixtures if WP-F06 has not yet: reference (do not own) `trees/v4/invalid/e-heading.bad-tag-enum.json`, `e-div-block.image-src-id-and-url.json`, `local-style.id-not-in-classes.json` (Contract 14 §1 names).

## Parallelization Notes

- Wave-1 core service. Parallel-safe with WP-P04 (writer/id/backup) and WP-P05 (css/cache) — disjoint files; the writer DEPENDS on this validator at the contract level (every WRITE WP lists this WP as a dependency per the universal rule).
- Every WRITE controller (WP-P06, P08, P09, P11, P12, P15) and the Pro WPs (WP-R##) list WP-P03 in `depends_on` because they must call `validate_only`/`dry_run` before persisting (Contract 10 §0.9). They consume the frozen `Validator` interface; they do not edit `class-validator.php`.
- Disjoint from WP-P02 (REST base) — uses its `Error` factory by reference only.
