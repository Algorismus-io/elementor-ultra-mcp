---
id: WP-R03
title: PHP Pro Forms — build widget + fields-repeater + actions + list_actions
layer: php
phase: ULTRA
status: planned
depends_on: [WP-F01, WP-F02, WP-F05, WP-P01, WP-P02, WP-P03, WP-P04, WP-P05, WP-P06, WP-S01, WP-R01]
files_owned:
  - plugin/elementor-ultra-mcp/includes/pro/class-form-builder-service.php
  - plugin/elementor-ultra-mcp/includes/pro/class-form-mapper.php
contract_refs:
  - spec/contracts/10-rest-api.md#85-post-proformbuild-get-proformactions
  - spec/contracts/11-authoring-contract.md#2-the-two-coexisting-node-schemas
  - spec/contracts/12-error-taxonomy.md#3
  - spec/contracts/13-tool-catalog.md#18-pro-surface
estimate: L
---

## Summary

Companion-plugin PHP for the Pro Forms surface: `POST /pro/form/build` maps an ergonomic field/action spec into the exact `form` widget node (V3 classic, or atomic `e-form` when `e_pro_atomic_form` is active) — `type→field_type`, `id→custom_id` (unique, `[A-Za-z0-9_]`), `required→"true"` (the STRING), `options→"label|value\n..."`, a unique repeater `_id` per field, `submit_actions = action types`, and per-action setting expansion — validating each action against `actions_registrar->get()` (license-gated) and each field type against the `elementor_pro/forms/field_types` filter. `GET /pro/form/actions` lists the registered actions. Owns `Form_Builder_Service` and the pure `Form_Mapper`.

## Interface / Contract

Implements REST routes (Contract 10 §8.5):

- `POST /pro/form/build` — CAP_EDIT_POST — emit a form widget element (classic or atomic).
- `GET  /pro/form/actions` — CAP_READ — registered (license-gated) form actions.

`Form_Builder_Service`:
- `routes(): array` — descriptors (registered by WP-R01 controller loop).
- `build(array $params): array|WP_Error` — map spec → widget node; when `post_id`+`container_id` present, insert + persist (via WP-P04 writer); else return `{element}` only (no persist) for the TS caller to place.
- `list_actions(): array` — `{ actions:[{name,label,settings_controls[]}] }` from `actions_registrar->get()`.

`Form_Mapper` (pure, unit-testable, no WP I/O):
- `map_fields(array $fields): array` — returns `form_fields` repeater array (each item with `_id`, `custom_id`, `field_type`, `field_label`, `required`, `field_options`, `width`, `rows`, `placeholder`, ...).
- `map_actions(array $actions): array` — returns `{ submit_actions:string[], settings:array }` (flat action settings merged into widget settings).
- `unique_custom_id(string $raw, array $taken): string` — sanitize to `[A-Za-z0-9_]`, dedupe.

## Dependencies & Inputs

Upstream WPs:
- WP-R01 — `Pro_Controller` (registers `routes()`), `Pro_Gate`. Consumed.
- WP-F01/F02/F05 — scaffold, REST contract, error taxonomy.
- WP-P04 — `Document_Writer` (granular element insert via WP-P06 Documents controller) (when building into a page, the widget is inserted under `container_id` via the granular element-op / save path with backup/lock/base_hash).
- WP-P03 — `Validator::dry_run()` (the produced widget node is validated before persist).
- WP-P05 + WP-S01 — `CssPrimer` (atomic `e-form` carries styles → prime required).

Contract sections: Contract 10 §8.5; §0.3 cap map; §0.6 error envelope; §0.8 base_hash/op_id; §0.9 dry-run; §0.10 prime. Authoring contract §2 (classic vs atomic node shape). Error codes Contract 12 §3.4 (`PRO_REQUIRED`, `EXPERIMENT_INACTIVE`), §3.1 (`ATOMIC_SETTINGS_INVALID`).

Elementor Pro APIs (cite in code):
- Form widget `widgetType='form'`, class `Forms\Widgets\Form extends Form_Base`, `get_name()='form'` — `plugins/elementor-pro/modules/forms/widgets/form.php:23-25`.
- Fields repeater `form_fields` — `form.php:564-598`; default 3 fields name/email(required)/message at `:569-595` (`custom_id` defaults `name`/`email` at `:571,581`).
- Field types (`field_type` SELECT default `'text'`) — `form.php:111-128`; filter `elementor_pro/forms/field_types` `:143`.
- Repeater keys (`field_label`, `placeholder`, `required` SWITCHER `return_value 'true'`, `field_options`, `width` `100..20` def `100`, `rows` def 4, `custom_id` TEXT `required:true`) — `form.php:151-537`; `custom_id` at `:507-535`; the `[field id="..."]` reference `:528`.
- Form-level controls (`form_name` def 'New Form', `button_text` def 'Send', `submit_actions` SELECT2 multiple def `['email']`) — `form.php:896-908`.
- Action registry `FEATURE_NAME_CLASS_NAME_MAP` — `forms/registrars/form-actions-registrar.php:19-32`; license filter `API::filter_active_features(...)` `:53`; `Form_Actions_Registrar extends Registrar` (`:17`) so registered set via `actions_registrar->get()`.
- Email action controls (`email_to`, `email_subject`, `email_content` def `[all-fields]`, `email_from`, `email_reply_to` = a field custom_id, `form_metadata`, `email_content_type`) — `forms/actions/email.php:42-224`. Redirect `redirect.php:34-55` (`redirect_to`). Webhook `webhook.php:32-59` (`webhooks` + `webhooks_advanced_data`).
- Atomic `e-form` (FREE) per-widget props — SUPPLEMENT §B.2 (`atomic-form.php`): `form-name`, `form-state`, `actions-after-submit` string-array def `['email']`, `submissions_metadata`, `email` (email prop-type), `webhook_url`. Atomic form INPUT children (`e-form-input` etc.) are PRO and injected under `e_pro_atomic_form`.
- `e_pro_atomic_form` experiment gate — Pro atomic module presence; SUPPLEMENT §B.2 note that `display-conditions` + atomic form children are Pro-injected via `elementor/atomic-widgets/props-schema` (`elementor-pro/modules/atomic-widgets/module.php:33,55,72`).

## Detailed Requirements

1. **Generation selection.** `generation` ∈ `{v3,v4}` (default per probe: `v4` only when `e_pro_atomic_form` active, else `v3`). For `v4` with `e_pro_atomic_form` INACTIVE → 409 `EXPERIMENT_INACTIVE` (`data.meta.experiment='e_pro_atomic_form'`) OR fall back to `v3` with a warning — contract default: fall back to `v3` and add `warnings:['atomic form unavailable; built classic form']`. Pro inactive at all → 501 `PRO_REQUIRED`.

2. **Field mapping (V3 classic, SUPPLEMENT §A.3/§A.7).** For each spec field: `type → field_type` (validate ∈ the base list `text,email,textarea,url,tel,radio,select,checkbox,acceptance,number,date,time,upload,password,html,hidden` PLUS any added by `elementor_pro/forms/field_types`); `id → custom_id` via `unique_custom_id()` (sanitize to `[A-Za-z0-9_]`, dedupe across fields); `label → field_label`; `placeholder → placeholder` (only for tel/text/email/textarea/number/url/password); `required:true → required:"true"` (THE STRING; excluded for checkbox/recaptcha/recaptcha_v3/hidden/html/step — drop it for those); `options:[{label,value}] → field_options` newline string `Label|value\n...` (select/checkbox/radio only); `rows → rows` (textarea); `width → width` (one of `100/80/75/70/66/60/50/40/33/30/25/20`, default `100`); `default_value → field_value`; `html → field_html` (html type only); assign a UNIQUE repeater `_id` per item (random 7-char per `includes/utils.php:373-375` style, dedup within the repeater).

3. **Action mapping.** `submit_actions = [action.type, ...]`. For each action, validate `action.type` is in `actions_registrar->get()` keys (license-gated set). If NOT registered → DO NOT abort; drop it from `submit_actions` and add `warnings:["action '<type>' not registered (license)"]` (SUPPLEMENT §A.7). Expand per-action settings flat into widget settings: `email → email_to,email_subject,email_content (def [all-fields]),email_from,email_from_name,email_reply_to,email_to_cc,email_to_bcc,form_metadata,email_content_type`; `email2` prefixes the same controls with `email2_`; `redirect → redirect_to`; `webhook → webhooks,webhooks_advanced_data (def 'no')`. Pass through unknown action settings via `passthrough()` semantics (the TS schema is `.passthrough()`).

4. **Form-level controls.** Map `form_name` (def 'New Form'), `button_text` (def 'Send'), `input_size`, `show_labels` (def 'true'), `form_id`. Emit only non-default keys (RESEARCH §4 classic rule: emit only non-default).

5. **Atomic `e-form` (V4) mapping.** When `e_pro_atomic_form` active and `generation='v4'`: build an `e-form` atomic widget node (typed envelopes) — `form-name:{$$type:string}`, `actions-after-submit:{$$type:string-array}`, `email:{$$type:email,...}` per SUPPLEMENT §B.1 email object + §B.2 e-form props — with child `e-form-input`/`e-form-textarea`/`e-form-select`/`e-form-submit-button` atomic widgets mapped from the field spec. The `e-form-input` `type` enum is `text,email,number,tel,password`; `e-form-submit-button` `text` is `html-v3` (author the `{content,children}` form per §B.2 note). Run through `Validator::dry_run()` (authoritative) before persist.

6. **Persist vs return-only.** When `post_id` + `container_id` present: validate the widget node via `Validator::dry_run()`, then insert it under `container_id` and persist via the WP-P04 writer (base_hash/lock/autosave/backup/op_id), set `prime_required` for atomic. When omitted: return `{element}` only, no persist, no base_hash (the TS caller places it). Response `data` per §8.5: `{ element, applied, base_hash?, warnings }`.

7. **`GET /pro/form/actions`.** Return ONLY actions present in `actions_registrar->get()` (license-gated). For each: `name`, `label`, `settings_controls` (the control ids the action registers — read from the action object's controls). Response: `{ actions:[{name,label,settings_controls[]}] }`.

8. **Error mapping (Contract 12).** Pro inactive → 501 `PRO_REQUIRED`; atomic form gate off + `v4` requested → fall back (warning) or 409 `EXPERIMENT_INACTIVE` if `generation` strictly `v4` and fallback disabled; invalid field_type not in filter → 422 with the offending field path; node validation fail → 422 `ATOMIC_SETTINGS_INVALID`; duplicate `custom_id` is resolved (not an error) by `unique_custom_id`.

9. **Op-log + base_hash.** When persisting, require `base_hash` (single-element insert is a surgical write, §0.8) and write an op-log row with `op_id`.

## Implementation Notes

- Keep `Form_Mapper` 100% pure (no WP calls) so it is unit-testable off-WP — it produces the exact `form_fields` array and flat action settings. `Form_Builder_Service` does the WP I/O (registrar lookup, validation, persist).
- `required` is the STRING `"true"` because the field SWITCHER uses `return_value 'true'` (`form.php` repeater) — a boolean `true` would NOT match and the field would render as optional. This is the #1 forms gotcha.
- The per-page count for actions: there is no limit; `submit_actions` is a SELECT2 multiple — order matters only for execution order.
- `email_reply_to` value is a field `custom_id` (a field reference), NOT an email address (`email.php`).
- For the worked example, mirror SUPPLEMENT §A.3 JSON exactly (3-field + email action) as a fixture.
- Atomic form children: only emit Pro inputs (`e-form-input`, etc.) when `e_pro_atomic_form` is active — they are NOT in the free static schema (SUPPLEMENT §B.2). Discover availability via `schema/registered-types` (WP-P07) rather than assuming.
- PHPCS clean; `path:line` comments on every Elementor call.

## Acceptance Criteria

- [ ] A 3-field spec (text required, email required, textarea) maps to a `form` widget whose `form_fields` has 3 items each with a unique `_id`, a unique sanitized `custom_id`, `required:"true"` (string) on the two required fields.
- [ ] `options` map to `field_options` as `Label|value\n...` for a select/radio/checkbox field; `placeholder` only emitted for placeholder-eligible types.
- [ ] `actions:[{type:'email',...}]` produces `submit_actions:['email']` + flat `email_to/email_subject/email_content` keys; an unregistered action (e.g. `mailchimp` without license) is dropped with a warning, not an error.
- [ ] `email2` action prefixes its controls with `email2_`.
- [ ] `GET /pro/form/actions` returns only `actions_registrar->get()` entries (verified by toggling a license-gated action off).
- [ ] With `post_id`+`container_id`, the widget is validated via `dry_run`, inserted, persisted; without them, only `{element}` is returned (no persist).
- [ ] `generation='v4'` with `e_pro_atomic_form` active produces an `e-form` atomic node that passes `dry_run`; with it inactive, falls back to `v3` + warning.
- [ ] Pro inactive → 501 `PRO_REQUIRED` on both routes.
- [ ] PHPCS clean; every Elementor call has a `path:line` comment.

## Tests Required

- PHPUnit (pure mapper): map the SUPPLEMENT §A.3 worked spec → assert the produced `form_fields` matches the §A.3 JSON (modulo random `_id`s); assert `required:"true"` string.
- PHPUnit (wp-env, Pro active): build into a container → assert the inserted widget validates via `dry_run`; assert `submit_actions` and email controls present.
- PHPUnit: unregistered action dropped + warning; `GET /pro/form/actions` filters by registrar.
- PHPUnit (e_pro_atomic_form active): build `e-form` atomic node → passes `dry_run`; with experiment off → classic fallback.
- PHPUnit (Pro inactive): both routes 501.
- Fixtures: `packages/shared/fixtures/trees/pro/form.classic-3field.json` (`requires:{pro:true}`) and `form.atomic-eform.json` (`requires:{pro:true,experiments:['e_pro_atomic_form']}`) owned by this WP.

## Parallelization Notes

- Parallel-safe with all other PHP WP-R siblings and all TS WP-R (disjoint files).
- Depends on WP-R01 (`Pro_Controller`/`Pro_Gate`) — consumed, no shared edits.
- Sequencing: merge after WP-R01, WP-P03/P04/P05/P06, WP-S01 PASS.
