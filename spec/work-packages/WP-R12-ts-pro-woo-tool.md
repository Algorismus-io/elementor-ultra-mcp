---
id: WP-R12
title: TS Pro WooCommerce tool (add_widget, context-validated) — ULTRA
layer: ts
phase: ULTRA
status: planned
depends_on: [WP-F01, WP-F03, WP-F04, WP-F05, WP-T01, WP-T04, WP-T05, WP-R06]
files_owned:
  - packages/server/src/tools/pro/woo.ts
  - packages/server/src/tools/pro/woo.test.ts
  - packages/shared/fixtures/envelopes/smoke.elementor.pro.woo.add_widget.json
contract_refs:
  - spec/contracts/13-tool-catalog.md#18-pro-surface
  - spec/contracts/10-rest-api.md#88-post-prowooadd-widget-context-validated-ultra-deferred
  - spec/contracts/12-error-taxonomy.md#3
estimate: S
---

## Summary

TypeScript MCP tool for the Pro WooCommerce surface: `elementor.pro.woo.add_widget`. Validates input against the frozen `ZodRawShape` (Contract 13 §1.8), proxies to `POST /pro/woo/add-widget` (the PHP layer classifies the widget by `get_categories()` and enforces the required theme-builder context), and surfaces `context_ok`/`context_warning`. Deferred to ULTRA; the contract is specified now. NON-star advanced tool.

## Interface / Contract

Registers (Contract 13 §1.8 verbatim):

- `elementor.pro.woo.add_widget` — Class M, Side BOTH (`POST /pro/woo/add-widget`). inputSchema: `post_id: z.number().int()`, `container_id: z.string()`, `widget: z.string()` (`woocommerce-*` / `wc-*`), `product_id?: z.number().int()` (for `wc-add-to-cart`), `settings?: z.record(z.string(),z.unknown())`, `base_hash: z.string()`. outputSchema: `element: ElementNode`, `diff: Diff`, `context_ok: z.boolean()`, `context_warning?: z.string()`, `base_hash: z.string()`. annotations: none.

## Dependencies & Inputs

Upstream WPs:
- WP-F01/F03/F04/F05; WP-T01 (server core), WP-T04 (typed client `routes.pro.wooAddWidget`), WP-T01 (advanced registry + `tools.search`).
- WP-R06 (PHP `/pro/woo/add-widget` route + `Woo_Context_Validator`) — runtime dependency; buildable against the frozen REST contract (Contract 10 §8.8) without it merged.

Contract sections: Contract 13 §0, §1.8; Contract 10 §8.8 (classification + context validation); Contract 12 §3.4 (`WOO_CONTEXT_INVALID`, `PRO_REQUIRED`). SUPPLEMENT §A.5 (the widget×context table surfaced in the description).

## Detailed Requirements

1. **Schema verbatim** per Contract 13 §1.8. `widget` is a free string (the Woo widget set is large and version-dependent — Contract 13 keeps it `z.string()` rather than an enum). `product_id` only meaningful for `wc-add-to-cart`.

2. **`base_hash` required** (surgical widget write). idempotency via the request defaults.

3. **Proxy.** Validate, call `routes.pro.wooAddWidget(...)`, shape `{element,diff,context_ok,context_warning,base_hash}`. The PHP layer does the classification + context check; the TS tool surfaces the result.

4. **Context-warning surfacing.** When `context_ok:false`, surface `context_warning` prominently in the result text (e.g. "woocommerce-product-title requires a Single-Product template; placed on actual_doc_type='wp-page'"). When the PHP returns a hard 422 `E_WOO_CONTEXT_INVALID`, map to `isError` `WOO_CONTEXT_INVALID` with the `{widget,required_context,actual_doc_type}` meta.

5. **Description hints (SUPPLEMENT §A.5).** Describe the three context classes: single-product widgets (need a Single-Product template), archive widgets (need a Shop/Archive template), context-free widgets (cart/checkout/my-account/menu-cart), and `wc-add-to-cart` (needs `product_id`, placeable anywhere). Steer the agent to create the right theme-builder doc (via `elementor.pro.theme.create`) before placing single/archive widgets.

6. **Error mapping** (Contract 13 §0.9, Contract 12): context mismatch → `isError` `WOO_CONTEXT_INVALID`; Pro/Woo inactive → `PRO_REQUIRED`/`EXPERIMENT_INACTIVE` (Woo not active); `wc-add-to-cart` without `product_id` → `VALIDATION_FAILED`; 404 → `NOT_FOUND`; stale `base_hash` → `CONCURRENCY_STALE_HASH`. Schema failures → `-32602`.

7. **Lean profile.** NON-star; disabled at boot; enabled via `tools.search` match on `elementor.pro.woo*`.

8. **Smoke payload.** `smoke.elementor.pro.woo.add_widget.json` = a minimal valid input (`{post_id, container_id, widget:'woocommerce-cart', base_hash}`) with `requires:{pro:true}` (and a Woo `requires` note) — the free/context-free widget so the smoke is least context-dependent.

## Implementation Notes

- Import shared `ElementNode`/`Diff` schemas (WP-F03); do not redefine.
- Do NOT replicate the §A.5 widget×context table in TS — classification is the PHP `Woo_Context_Validator`'s authoritative job (WP-R06). The TS tool surfaces the verdict. The table belongs in the tool description + an MCP resource for agent guidance only.
- This is the lowest-priority, smallest WP-R (ULTRA, deferred Woo) — ship the tool + schema + error surfacing; full per-widget settings guidance can be additive later.
- Exports `registerProWooTools(server, registry)` consumed by the `tools/pro/index.ts` barrel (WP-T01).

## Acceptance Criteria

- [ ] Tool registered with exact Contract 13 §1.8 name/title/inputSchema/outputSchema/annotations.
- [ ] `base_hash` required.
- [ ] `add_widget` proxies `POST /pro/woo/add-widget`; shapes `{element,diff,context_ok,context_warning,base_hash}`.
- [ ] Context mismatch (single widget on a page) → `isError` `WOO_CONTEXT_INVALID` with `{widget,required_context,actual_doc_type}`.
- [ ] `wc-add-to-cart` without `product_id` → `isError` `VALIDATION_FAILED`.
- [ ] Woo/Pro inactive → `isError` `PRO_REQUIRED`/`EXPERIMENT_INACTIVE`.
- [ ] Description enumerates the §A.5 context classes.
- [ ] NON-star, disabled at boot, enabled via `tools.search`.
- [ ] Smoke payload present with `requires:{pro:true}`.
- [ ] Strict TS, no `any`, lint+format clean.

## Tests Required

- vitest unit (mocked client): schema validation; `base_hash` required; `wc-add-to-cart` product_id guard; response shaping; error mapping for context-invalid / 501 / 409 / 404.
- vitest contract: name/schema snapshot vs Contract 13 §1.8.
- Inspector smoke: `smoke.elementor.pro.woo.add_widget.json` (skipped free-only / Woo-absent).

## Parallelization Notes

- Parallel-safe with all other TS WP-R (disjoint files) and all PHP WP-R.
- Depends on WP-T01 (barrel/registry), WP-T04 (typed routes); consumes via stable interfaces.
- Buildable against frozen contracts before WP-R06 lands; integration needs WP-R06 + a Pro+Woo wp-env. ULTRA phase, lowest priority.
