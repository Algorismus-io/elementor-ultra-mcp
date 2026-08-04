---
id: WP-R05
title: PHP Pro Dynamic Tags — bind (tag_to_text mirror) + list + per-tag schema
layer: php
phase: ULTRA
status: planned
depends_on: [WP-F01, WP-F02, WP-F05, WP-P01, WP-P02, WP-P03, WP-P04, WP-P06, WP-P07, WP-R01]
files_owned:
  - plugin/elementor-ultra-mcp/includes/pro/class-dynamic-tags-service.php
  - plugin/elementor-ultra-mcp/includes/pro/class-dynamic-encoder.php
contract_refs:
  - spec/contracts/10-rest-api.md#87-post-prodynamicbind-get-prodynamictags-get-prodynamictagsname
  - spec/contracts/12-error-taxonomy.md#3
  - spec/contracts/13-tool-catalog.md#18-pro-surface
estimate: M
---

## Summary

Companion-plugin PHP for Dynamic Tags: `POST /pro/dynamic/bind` writes a dynamic binding byte-identical to core `Manager::tag_to_text` — `[elementor-tag id="<rand7>" name="<tag>" settings="<urlencode(wp_json_encode($settings, JSON_FORCE_OBJECT))>"]` into `settings.__dynamic__[control]` (V3) or the atomic dynamic prop envelope (V4) — and validates `control.dynamic.active==true`, the tag is registered, and the tag category intersects the control's dynamic categories. `GET /pro/dynamic/tags` and `/pro/dynamic/tags/{name}` list tags and per-tag controls. Owns `Dynamic_Tags_Service` and the pure `Dynamic_Encoder`.

## Interface / Contract

Implements REST routes (Contract 10 §8.7):

- `POST /pro/dynamic/bind` — CAP_EDIT_POST — write `__dynamic__` (V3) / atomic dynamic (V4).
- `GET  /pro/dynamic/tags` — CAP_READ — list dynamic tags (paginated per §0.11).
- `GET  /pro/dynamic/tags/{name}` — CAP_READ — per-tag controls/args.

`Dynamic_Tags_Service`:
- `routes(): array` — descriptors (registered by WP-R01 controller loop).
- `bind(array $params): array|WP_Error`.
- `list_tags(array $query): array` — paginated `{items:[{name,title,group,categories[],settings_controls[],available}]}`.
- `get_tag_schema(string $name): array|WP_Error` — `{name,controls,categories,group}`.

`Dynamic_Encoder` (pure, unit-testable, no WP I/O except `wp_json_encode`/`urlencode`):
- `encode(string $tag_name, array $settings, ?string $id=null): string` — returns the exact shortcode string; default `id` = random 7-char; EMPTY settings → `settings="%7B%7D"` (urlencoded `{}`), never empty string.

## Dependencies & Inputs

Upstream WPs:
- WP-R01 — `Pro_Controller` (registers `routes()`), `Pro_Gate`. Consumed.
- WP-F01/F02/F05 — scaffold, REST contract, error taxonomy.
- WP-P04 — `Document_Writer` (granular element insert via WP-P06 Documents controller) (the dynamic binding mutates one element's settings via the surgical element-op/save path with base_hash/lock/autosave/backup/op_id).
- WP-P03 — `Validator::dry_run()` (the resulting node validated before persist) AND `schema/widget` (to read `control.dynamic.active` + `control.dynamic.categories` for V3, and the atomic dynamic-capable prop for V4).

NOTE: dynamic-tags binding mutates settings only (no new styles) so it does NOT depend on WP-P05/CssPrimer or WP-S01 — there is no atomic-CSS effect. (Per the universal rule, this WP still depends on the dry_run validator WP-P03 because it is a WRITE.)

Contract sections: Contract 10 §8.7; §0.3 cap map; §0.6 error; §0.8 base_hash/op_id; §0.9 dry-run. Error codes Contract 12: `E_DYNAMIC_INCOMPATIBLE` (REST) / `DYNAMIC_INCOMPATIBLE`-equivalent surfaced as `VALIDATION_FAILED` with meta.

Elementor APIs (cite in code):
- Core `Manager::tag_to_text()` — `plugins/elementor/core/dynamic-tags/manager.php:141-142`: `sprintf('[%1$s id="%2$s" name="%3$s" settings="%4$s"]', 'elementor-tag', $tag->get_id(), $tag->get_name(), urlencode(wp_json_encode($settings, JSON_FORCE_OBJECT)))`.
- `TAG_LABEL='elementor-tag'` — `manager.php:16`; decoder regex requires all three of id/name/settings — `manager.php:113-127`.
- `DYNAMIC_SETTING_KEY='__dynamic__'` — `manager.php:22`; binding stored under `settings.__dynamic__[control]`.
- Only controls declared `dynamic => ['active'=>true]` accept a binding; the tag's category must intersect the control's `dynamic.categories` (SUPPLEMENT §A.6).
- Module `Modules\DynamicTags\Module extends TagsModule`, `get_name()='tags'` — `dynamic-tags/module.php:15,90`; groups `:17-31,144-171`; core categories TEXT/URL/IMAGE/MEDIA/POST_META/COLOR/DATETIME.
- Core/Pro tag registry — `module.php:98-134` (core); Pro adds post/archive/site/author/comments/woo groups; ACF `acf/module.php:206-217` (`key` = `{field_key}:{field_name}`).
- Representative tag settings (post-title none; post-excerpt `max_length,apply_to_post_content`; post-featured-image `fallback`; current-date-time `date_format,...`) — SUPPLEMENT §A.6.

## Detailed Requirements

1. **Encoder (byte-identical, SUPPLEMENT §A.6).** `Dynamic_Encoder::encode()` MUST reproduce `tag_to_text` EXACTLY: `[elementor-tag id="<id>" name="<tag>" settings="<urlencode(wp_json_encode($settings, JSON_FORCE_OBJECT))>"]`. Use `JSON_FORCE_OBJECT` so `{}` not `[]` for empty/assoc. `id` = a random 7-char alphanumeric. EMPTY settings → `settings="%7B%7D"` (the urlencoded `{}`), NOT empty string — this is the #1 dynamic gotcha. Verify against the three SUPPLEMENT §A.6 worked strings (post-title, post-featured-image, acf-text).

2. **Validation before write.** Read the target widget's control schema via WP-P07's `schema/widget` helper (do NOT re-derive). Assert: (a) `control.dynamic.active === true` for the named `control`; (b) the `tag` is registered (`Plugin::$instance->dynamic_tags->get_tag_info($tag)` or the Pro tags manager); (c) the tag's categories ∩ the control's `dynamic.categories` is non-empty. Any failure → 422 `E_DYNAMIC_INCOMPATIBLE` (`data.meta.{control,tag,control_categories,tag_categories}`).

3. **V3 write.** Set `settings.__dynamic__[control] = <shortcode>`. Optionally set `settings[control] = fallback_value` (the static fallback shown when the tag resolves empty). Persist via the WP-P04 writer (read element → mutate settings → `dry_run` → `Document::save()` with base_hash/lock/autosave/backup/op_id).

4. **V4 atomic write.** The atomic dynamic prop `$$type`/payload is SPIKE-discovered via `schema/widget` (which flags dynamic-capable props) and is NOT statically known (RESEARCH §4.3 OQ#7, §10 OQ). For V4: read the dynamic-capable prop shape from `schema/widget`; build the atomic dynamic envelope accordingly; if the prop is not dynamic-capable → 422 `E_DYNAMIC_INCOMPATIBLE`. Until the shape is confirmed, V4 dynamic returns a `warnings:['atomic dynamic prop shape unverified — verify via schema.widget']` and still produces the V3-style `__dynamic__` if the atomic settings accept it; otherwise 409 `EXPERIMENT_INACTIVE`-style soft error. Document this clearly as spike-dependent.

5. **Response.** `data` per §8.7: `{ dynamic_string, applied:bool, base_hash:<new> }`. When `post_id`/`element_id` omitted (encode-only mode), return `{ dynamic_string, applied:false }` with no persist (the TS caller writes it).

6. **`GET /pro/dynamic/tags`.** Paginated list from the tags manager: per tag `{name,title,group,categories[],settings_controls[],available}` where `available` reflects license-gating (ACF tags require `dynamic-tags-acf` license). Free vs Pro tags both listed; `available:false` for license-gated-but-registered placeholders.

7. **`GET /pro/dynamic/tags/{name}`.** Return the tag's `controls` (its settings controls), `categories`, `group`. 404 `E_NOT_FOUND` if the tag is not registered.

8. **Error mapping (Contract 12).** Pro inactive → 501 `PRO_REQUIRED` (note: core dynamic tags exist without Pro, but the FULL tag set is Pro — so `bind` works for core tags even without Pro; only Pro/ACF tags 501/unavailable). Control not dynamic-capable or category mismatch → 422 `E_DYNAMIC_INCOMPATIBLE`. Element not found → 404.

## Implementation Notes

- `Dynamic_Encoder` is pure and the highest-value unit target — its output must be byte-for-byte equal to PHP `wp_json_encode($s, JSON_FORCE_OBJECT)` then `urlencode`. The TS mirror (WP-R11) MUST produce the SAME string for the same input; add a cross-runtime fixture so TS and PHP agree (see Tests).
- Do NOT use `json_encode` without `JSON_FORCE_OBJECT` — an empty array would serialize to `[]` and the decoder regex/tag system expects `{}`.
- The random 7-char `id` makes the string non-deterministic; for idempotency/cross-runtime tests, allow passing a fixed `id` (the `?id` param) so fixtures are stable.
- Read control `dynamic` config from the post-filter `get_props_schema()` / `get_controls()` exposed by WP-P07's schema route — never re-implement control introspection here.
- Core dynamic tags work without Pro; gate ONLY the Pro/ACF tag families behind `Pro_Gate`.
- PHPCS clean; `path:line` comments on every Elementor call.

## Acceptance Criteria

- [ ] `Dynamic_Encoder::encode('post-title',[],'a1b2c3d')` == `[elementor-tag id="a1b2c3d" name="post-title" settings="%7B%7D"]` (SUPPLEMENT §A.6).
- [ ] `encode('post-featured-image',{fallback:{id:'',url:''}},'b2c3d4e')` and `encode('acf-text',{key:'field_5f3a1b2c:project_client'},'c3d4e5f')` match the §A.6 worked strings exactly.
- [ ] Empty settings produce `settings="%7B%7D"`, never empty string.
- [ ] `bind` into a dynamic-capable control writes `settings.__dynamic__[control]` and persists; the node passes `dry_run`.
- [ ] Binding to a NON-dynamic control → 422 `E_DYNAMIC_INCOMPATIBLE` with category meta.
- [ ] Binding a tag whose category does not intersect the control's `dynamic.categories` → 422.
- [ ] `GET /pro/dynamic/tags` lists tags with `available` reflecting license-gating; `GET /pro/dynamic/tags/{name}` returns controls or 404.
- [ ] Encode-only mode (no post_id) returns `{dynamic_string,applied:false}` with no persist.
- [ ] PHPCS clean; every Elementor call has a `path:line` comment.

## Tests Required

- PHPUnit (pure encoder): the 3 SUPPLEMENT §A.6 worked strings; empty-settings `%7B%7D`.
- Cross-runtime fixture: `packages/shared/fixtures/trees/pro/dynamic.encodings.json` (owned by this WP) holding `{tag,settings,id,expected_string}` rows — consumed by BOTH this WP's PHPUnit AND WP-R11's vitest so PHP and TS encoders agree byte-for-byte.
- PHPUnit (wp-env): bind into a dynamic-capable heading `title` control → assert `__dynamic__.title` shortcode; bind into a non-dynamic control → 422.
- PHPUnit: category-intersection rejection.
- PHPUnit: `GET` list + per-tag schema; ACF tag `available:false` without license.

## Parallelization Notes

- Parallel-safe with all other PHP WP-R siblings and all TS WP-R (disjoint files).
- Shares ONLY the read-only cross-runtime fixture `dynamic.encodings.json` with WP-R11 (TS); this WP OWNS/creates it, WP-R11 consumes it read-only — no write contention.
- Depends on WP-R01 (`Pro_Controller`/`Pro_Gate`) + WP-P07 (`schema/widget` for control introspection) — consumed.
- Sequencing: merge after WP-R01, WP-P03/P04/P06/P07.
