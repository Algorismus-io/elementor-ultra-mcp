---
id: WP-T06
title: TS tool handlers — widget / element ops (get, insert, update_settings, move, delete, set_classes, set_local_style, bind_dynamic, bind_global)
layer: ts
phase: MVP
status: planned
depends_on: [WP-F01, WP-F02, WP-F03, WP-F04, WP-T01, WP-T03, WP-P03, WP-P05, WP-S01]
files_owned:
  - packages/server/src/tools/widget.ts
  - packages/server/src/tools/widget.test.ts
contract_refs:
  - spec/contracts/13-tool-catalog.md §1.3 (widget/element ops), §0.7-§0.9
  - spec/contracts/10-rest-api.md §1 DOCUMENTS (granular /documents/{id}/elements), §2.4
  - spec/contracts/11-authoring-contract.md §2-§4 (nodes, envelopes, local-style mirror, dynamic/global)
  - spec/contracts/12-error-taxonomy.md §3, §5
estimate: L
---

## Summary

Implements the HANDLERS for the surgical single-element op tools (Contract 13 §1.3) and attaches them to the WP-F04 registry: `element.get`, `widget.insert`, `widget.update_settings`, `element.move`, `element.delete`, `element.set_classes`, `element.set_local_style`, `element.bind_dynamic`, `element.bind_global`. Each mutating op is a PHP-side read-mutate-validate-write transaction (one `Document::save()`), `base_hash` + `op_id` guarded, mapped to the granular route `POST /documents/{id}/elements`.

## Interface / Contract

Attaches `ToolHandler`s via `ctx.registry.attachHandler(name, fn)`; schemas owned by WP-F04 (Contract 13 §1.3):

- `element.get` (R, `GET /documents/{id}` subtree) — `{post_id,element_id}` → `{node,base_hash}`.
- `widget.insert` ★ (M, op `insert`) — `{post_id,parent_id,index?,node,base_hash,op_id?,force?}` → `{diff,inserted_id,base_hash}`.
- `widget.update_settings` ★ (M, op `update_settings`) — `{post_id,element_id,settings,base_hash,force?}` → `{diff,base_hash}`.
- `element.move` (M, op `move`) — `{post_id,element_id,new_parent_id,index,base_hash,force?}` → `{diff,base_hash}`.
- `element.delete` (D, op `delete`) — `{post_id,element_id,base_hash,confirm?,force?}` → `{diff,base_hash}`. Elicitation.
- `element.set_classes` (M, op `set_classes`) — `{post_id,element_id,class_ids[],base_hash}` → `{diff,base_hash}`.
- `element.set_local_style` (M, op `set_local_style`) — `{post_id,element_id,style_id?,variant,base_hash}` → `{diff,style_id,base_hash}`.
- `element.bind_dynamic` (M, op `bind_dynamic`) — `{post_id,element_id,control,tag_name,tag_settings?,fallback_value?,base_hash}` → `{diff,dynamic_string,base_hash}`.
- `element.bind_global` (M, op `bind_global`) — `{post_id,element_id,control,global_ref,base_hash}` → `{diff,base_hash}`.

## Dependencies & Inputs

- WP-T01 (`ToolContext`/`ToolHandler`; `ctx.elicit`). Code.
- WP-F02 (`WpRoutes.documentElements` granular op-batch route; `getDocument` for `element.get`). Code via `ctx.wp`.
- WP-F03 (envelope builders for `set_local_style.variant` + `set_classes`; `mintLocalStyleId`/local-style mirror helper; `StyleVariant`/`ElementNode` types; `prefilter`). Code.
- WP-T03 (`mintOpId`/`isReplay`/`presentDiff`). Code.
- WP-F04 (catalog + `attachHandler`). Code.
- WP-P03 (PHP `dry_run` validator) — MANDATORY WRITE dependency (each op validates before persisting, Contract 10 §0.9).
- WP-P05 (CSS_Primer) + WP-S01 — MANDATORY atomic-CSS dependency: a settings/style change on an atomic node may require re-prime; the route reports `css_primed`/`prime_required` (Contract 10 §0.10).
- Contract 13 §1.3, §0.8 (surgical writes REQUIRE base_hash; op_id; force), §0.7 (return Diff+base_hash). Contract 10 §1 DOCUMENTS granular enum (`insert|update_settings|move|delete|set_classes|set_local_style|bind_dynamic|bind_global`), §2.6 transactional. Contract 11 §2.1 (local-style mirrored into `settings.classes.value`), §3 (envelopes), §2.3 (V3 `__dynamic__`/`__globals__`), SUPPLEMENT §A.6. Contract 12 §3 (`CONCURRENCY_STALE_HASH`,`LOCK_HELD`,`AUTOSAVE_CONFLICT`,`LOCAL_STYLE_UNLINKED`,`NOT_FOUND`).

## Detailed Requirements

1. Attach handlers for all nine §1.3 tools; ★ members: `widget.insert`, `widget.update_settings` (Contract 13 §5.2).
2. Each mutating op submits ONE granular operation via `ctx.wp.documentElements(post_id,{ops:[{op,...}],base_hash,op_id?,force?})`; PHP does ONE `Document::save()` transaction (Contract 10 §2.6). A shared internal `submitOp(...)` helper keeps the shape uniform.
3. `base_hash` REQUIRED on every mutating op (Contract 13 §0.8); mismatch → `CONCURRENCY_STALE_HASH` (re-read via `page.get_structure`); `force` overrides lock/autosave.
4. `set_local_style`: build `StyleVariant` via WP-F03 envelopes; mint `style_id` (`mintLocalStyleId(element_id)`) if absent; ensure the style id is mirrored into the element's `classes` prop (WP-F03 local-style mirror helper) so it is not detached (Contract 11 §2.1; detached → `LOCAL_STYLE_UNLINKED`). Return resolved `style_id`. The pre-filter catches a detached style client-side for fast feedback.
5. `set_classes`: `class_ids[]` are bare ids (global `g-*` + local `e-*`), validated by the envelope `classes` regex; sets the BARE-array `classes` value (Contract 11 §3).
6. `bind_dynamic`: V3 `settings.__dynamic__[control]` shortcode (`[elementor-tag id=".." name="tag_name" settings="<urlencoded JSON_FORCE_OBJECT>"]`, Contract 11 §2.3 / SUPPLEMENT §A.6); V4 atomic dynamic discovered via `schema.widget`. PHP produces the canonical `dynamic_string`; the tool returns it. `fallback_value` passed through. (The byte-identical Pro mirror is WP-R##'s `pro.dynamic.bind`.)
7. `bind_global`: V3 `settings.__globals__[control]=global_ref` (e.g. `globals/colors?id=primary`).
8. `element.delete` destructive → elicitation when `confirm!=true`; decline → clean non-error.
9. `element.get` returns `{node,base_hash}` (read).
10. Every mutating op returns `presentDiff(diff)` + new `base_hash`; surface `IDEMPOTENT_REPLAY` on replay. Errors per Contract 12 §5; arg errors `-32602`. No `any`.

## Implementation Notes

- The local-style mirror (rule 4) is the highest-risk invariant — route ALL local-style writes through the WP-F03 mirror helper so `classes` + `styles` stay consistent.
- All eight mutating tools share one REST method (`documentElements`); the `submitOp` helper centralizes base_hash/op_id/force + diff presentation.
- `op_id`: insert/style ops accept it for idempotency (Contract 13 §0.8); deterministic mint (WP-T03) when omitted.
- Do NOT byte-reproduce Pro `tag_to_text` here (WP-R## `pro.dynamic.bind`); the FREE `bind_dynamic` builds the request and PHP canonicalizes.

## Acceptance Criteria

- [ ] Handlers attached for all nine §1.3 tools; ★ match §5.2.
- [ ] Every mutating op submits ONE granular operation, requires base_hash, returns `{diff,base_hash}` (+ inserted_id/style_id).
- [ ] `set_local_style` mints/links the style id into `classes` (no detached styles; pre-filter catches it early).
- [ ] `bind_dynamic`/`bind_global` produce correct V3 encodings and surface `dynamic_string`.
- [ ] `element.delete` elicitation-gated.
- [ ] base_hash/lock/autosave → correct codes; `force` overrides; `IDEMPOTENT_REPLAY` surfaced.
- [ ] No `any`; strict `tsc` + lint clean.

## Tests Required

- `tools/widget.test.ts` (vitest, no WP): mock `ctx.wp`/elicit; assert each op→correct granular `op` + base_hash/op_id; assert local-style mirror; assert dynamic/global encoding; assert delete elicitation + decline; assert base_hash/lock error mapping; assert pre-filter catches detached local style pre-REST.

## Parallelization Notes

- Owns only `tools/widget.ts` + test — disjoint from every other `tools/*`.
- Wave 2; integration blocked on S1 + WP-P03/WP-P05. Parallel-safe with all other handler WPs.
