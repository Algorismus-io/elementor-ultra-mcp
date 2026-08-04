---
id: WP-R06
title: PHP Pro WooCommerce — context-validated add-widget (ULTRA)
layer: php
phase: ULTRA
status: planned
depends_on: [WP-F01, WP-F02, WP-F05, WP-P01, WP-P02, WP-P03, WP-P04, WP-P05, WP-P06, WP-S01, WP-R01]
files_owned:
  - plugin/elementor-ultra-mcp/includes/pro/class-woo-service.php
  - plugin/elementor-ultra-mcp/includes/pro/class-woo-context-validator.php
contract_refs:
  - spec/contracts/10-rest-api.md#88-post-prowooadd-widget-context-validated-ultra-deferred
  - spec/contracts/12-error-taxonomy.md#3
  - spec/contracts/13-tool-catalog.md#18-pro-surface
estimate: M
---

## Summary

Companion-plugin PHP for the WooCommerce widget surface (deferred to ULTRA; the context-validation contract is specified now). `POST /pro/woo/add-widget` classifies a Woo widget by its category (`get_categories()`) and enforces the required theme-builder context — single-product widgets require a Single-Product template, archive widgets require a Shop/Archive template, context-free widgets (cart/checkout/my-account/menu-cart/`wc-add-to-cart`) place anywhere — returning `E_WOO_CONTEXT_INVALID` on a mismatch. Owns `Woo_Service` and the pure `Woo_Context_Validator` (which encodes the SUPPLEMENT §A.5 widget×context table).

## Interface / Contract

Implements REST route (Contract 10 §8.8):

- `POST /pro/woo/add-widget` — CAP_EDIT_POST — context-validated Woo widget config.

`Woo_Service`:
- `routes(): array` — descriptors (registered by WP-R01 controller loop).
- `add_widget(array $params): array|WP_Error`.

`Woo_Context_Validator` (pure, unit-testable, no WP I/O beyond the live category lookup which is injected):
- `classify(string $widget, array $categories): string` — returns one of `single|archive|free|global` from the widget's `get_categories()` (or the static §A.5 table fallback when the widget object is unavailable).
- `required_doc_types(string $context): string[]` — `single` → single-product theme-builder doc types; `archive` → shop/archive doc types; `free`/`global` → `[]`.
- `validate(string $context, string $actual_doc_type): WP_Error|true`.

## Dependencies & Inputs

Upstream WPs:
- WP-R01 — `Pro_Controller` (registers `routes()`), `Pro_Gate`. Consumed.
- WP-F01/F02/F05 — scaffold, REST contract, error taxonomy.
- WP-P04 — `Document_Writer` (granular element insert via WP-P06 Documents controller) (the Woo widget is inserted under `container_id` and persisted with base_hash/lock/autosave/backup/op_id).
- WP-P03 — `Validator::dry_run()` (the produced widget node validated before persist).
- WP-P05 + WP-S01 — `CssPrimer` (Woo widget atomic styles, if any → prime required).

Contract sections: Contract 10 §8.8; §0.3 cap map; §0.6 error; §0.8 base_hash/op_id; §0.9 dry-run; §0.10 prime. Error code Contract 12 §3.4 `WOO_CONTEXT_INVALID` (REST `E_WOO_CONTEXT_INVALID`).

Elementor Pro APIs (cite in code):
- `Base_Widget` default category `woocommerce-elements-single` — `plugins/elementor-pro/modules/woocommerce/widgets/base-widget.php:20-22` (`get_categories()` returns `['woocommerce-elements-single']`).
- Widget×category×context table — SUPPLEMENT §A.5: single family `woocommerce-product-title/-price/-images/-add-to-cart/-rating/-stock/-meta/-short-description/-content/-data-tabs/-additional-information`, `woocommerce-product-related`, `woocommerce-product-upsell` (`Products_Base`), `woocommerce-category-image`, `woocommerce-breadcrumb` → `woocommerce-elements-single`; archive family `wc-archive-products` (`Archive_Products`), `woocommerce-archive-description`, `woocommerce-products` (`Products`), `wc-categories` → `woocommerce-elements-archive`; context-free `woocommerce-cart`, `woocommerce-checkout-page`, `woocommerce-my-account`, `woocommerce-purchase-summary`, `woocommerce-notices` → `woocommerce-elements`; `woocommerce-menu-cart` → `theme-elements`,`woocommerce-elements`; `wc-add-to-cart` (`Add_To_Cart extends Widget_Button`) → global, takes explicit `product_id`, placeable anywhere.
- Doc-type slugs for context: single-product theme-builder doc, products-archive/shop template — derived via the target doc's `_elementor_template_type` + Woo module template registration. RESEARCH §5.8 Woo context note.
- Woo gotcha: when Woo active, `product` removed from `Module::get_public_post_types()` (`theme-builder/module.php:44-46`).

## Detailed Requirements

1. **Pro + Woo presence.** `Pro_Gate::require_pro()`; then assert WooCommerce active AND the Pro Woo module loaded (`class_exists` checks). If Woo inactive → 501 `E_FEATURE_UNAVAILABLE` (`data.meta.{pro_active:true, woocommerce:false}`).

2. **Classification.** Resolve the widget's `get_categories()` via the live widgets manager when the widget type is registered; otherwise fall back to the static §A.5 table. `Woo_Context_Validator::classify()` maps category → context: `woocommerce-elements-single → single`; `woocommerce-elements-archive → archive`; `woocommerce-elements`/`theme-elements`-only → free; `wc-add-to-cart` → global.

3. **Context validation.** Read the TARGET document's `_elementor_template_type`. For `single` context, the doc MUST be a single-product theme-builder template (or be on a product page context). For `archive` context, the doc MUST be a products-archive/shop template. On mismatch → 422 `E_WOO_CONTEXT_INVALID` (`data.meta.{widget,required_context,actual_doc_type}`). `free`/`global` contexts skip validation. `wc-add-to-cart` with an explicit `product_id` is placeable anywhere (global) — no context error, but `product_id` REQUIRED for it.

4. **Soft warning mode.** Per §8.8 the response carries `context_ok` + `context_warning`. When the context is technically wrong but the caller might know better (e.g. a custom template not recognized as single-product), the validator MAY return `context_ok:false` with a `context_warning` AND still place the widget ONLY if the request carries `force:true`; default behaviour is the hard 422. (Document both; default = hard fail.)

5. **Build + persist.** When validated, build the widget node (classic or atomic per probe; most Woo widgets are classic), validate via `dry_run`, insert under `container_id`, persist via writer (base_hash/lock/autosave/backup/op_id), prime atomic styles if any. Response `data` per §8.8: `{ element, context_ok, context_warning, base_hash:<new> }`.

6. **`wc-add-to-cart`.** Requires `product_id` (the product to add). Set it into the widget settings (`product_id` control). Placeable on any doc.

7. **Loop coupling note.** This WP only handles `add-widget`; the loop product skins (`product`/`product_taxonomy`) are owned by WP-R04 (`bind-grid` gating). No overlap.

8. **Error mapping (Contract 12).** Pro/Woo inactive → 501; context mismatch → 422 `WOO_CONTEXT_INVALID`; container/post not found → 404; node validation fail → 422 `ATOMIC_SETTINGS_INVALID`.

## Implementation Notes

- Keep `Woo_Context_Validator` pure with the §A.5 table baked in as a constant map AND a live-`get_categories()` override path (so new Woo widgets classify correctly without a table edit). The table is the fallback for unregistered/known types.
- The "actual doc type is single-product" check: read `_elementor_template_type`; single-product theme docs use the single/single-post family with Woo's product association. Document the exact slug set as `data.meta.required_context` (e.g. `single-product`) and accept the Woo module's registered product-single doc type. Because Woo removes `product` from public post types for theme conditions (`theme-builder/module.php:44-46`), do NOT validate via theme conditions — validate via the doc's own type.
- Most Woo widgets are classic (V3); emit a classic node by default. If an atomic Woo widget exists on the target (probe `schema/registered-types`), emit atomic.
- This is ULTRA-phase; ship the route + validator + tests now, but the full Woo widget settings mapping (per-widget control sets) can be additive later. The CONTRACT (context validation + error code) is the load-bearing deliverable.
- PHPCS clean; `path:line` comments on every Elementor/Woo call.

## Acceptance Criteria

- [ ] `woocommerce-product-title` on a non-single-product doc → 422 `E_WOO_CONTEXT_INVALID` with `{widget,required_context:'single',actual_doc_type}` meta.
- [ ] `woocommerce-product-title` on a single-product doc → `context_ok:true`, widget inserted + validated.
- [ ] `wc-archive-products` on a shop/archive doc → ok; on a single-product doc → 422.
- [ ] `woocommerce-cart` (free) places on any doc with `context_ok:true`.
- [ ] `wc-add-to-cart` without `product_id` → 400/422; with `product_id` places anywhere.
- [ ] `Woo_Context_Validator::classify()` returns `single/archive/free/global` matching the §A.5 table for every listed widget.
- [ ] Pro inactive OR Woo inactive → 501 `E_FEATURE_UNAVAILABLE` with the right meta.
- [ ] PHPCS clean; every Elementor/Woo call has a `path:line` comment.

## Tests Required

- PHPUnit (pure validator): for each §A.5 widget, assert `classify()` and `required_doc_types()`; assert mismatch → `WP_Error` with `WOO_CONTEXT_INVALID`.
- PHPUnit (wp-env, Pro + Woo active): place a single widget on a single-product doc (ok) and a page (422); place a free widget anywhere (ok).
- PHPUnit (Woo inactive): route 501.
- Fixtures: `packages/shared/fixtures/trees/pro/woo.product-title-single.json` and `woo.cart-anywhere.json` with `requires:{pro:true}` (and a `requires` note for Woo) owned by this WP.

## Parallelization Notes

- Parallel-safe with all other PHP WP-R siblings and all TS WP-R (disjoint files).
- Depends on WP-R01 (`Pro_Controller`/`Pro_Gate`) — consumed.
- Sequencing: ULTRA phase; merge after WP-R01, WP-P03/P04/P05/P06, WP-S01 PASS. Lowest priority of the WP-R PHP set (deferred), but the validator/contract should land early so the TS WP-R12 can build against it.
