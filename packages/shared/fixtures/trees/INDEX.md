# Golden element-tree fixtures (WP-Q01)

The golden element-tree corpus: ≥1 VALID fixture per supported atomic widget
(SUPPLEMENT §B.2), the composite hero, a state/breakpoint style variant, one
INVALID fixture per failure-mode error code, V3 valid/invalid, and the design
diff-PUT + variables-batch bodies. These back WP-F06's round-trip + pre-filter
suites and the render-assertion / schema-drift suites
(`spec/contracts/14-fixtures-harness.md §1–4`, `§9`).

Every file follows the LOCKED envelope (`§2`): `$fixture, id, kind, generation,
title, expect{valid,errors[]}, requires{experiments,pro,min_elementor}, tree[],
settings, prefilter{verdict}`. `expect.valid` + `expect.errors[]` are the
**PHP `Validator::dry_run()` verdict** — the SINGLE SOURCE OF TRUTH (`§3`) —
established by round-tripping every `tree[]` through the live companion
`Validator::dry_run()` on the pinned **Elementor 4.1.1 + Pro 4.1.0** dev site
(V4 experiments `e_atomic_elements` / `e_classes` / `e_variables` active), NOT
guessed. `expect.errors[]` are SCREAMING_SNAKE_CASE taxonomy codes only
(`spec/contracts/12-error-taxonomy.md §6`) — never raw Elementor throw strings.

## Key invariants honored

- **[R8] strictly-typed envelopes.** Every atomic prop value is a `{$$type,value}`
  envelope whose `$$type` equals the prop's `get_key()` — bare strings fail the
  authoritative validator (`tag`/`title` `invalid_value`, local-style label
  `class_name_too_short`). `classes` value is a BARE string array (no inner wrap).
- **[R5] local-style ids are NOT stable.** Fixtures never assume a local-style id
  survives a save — Elementor regenerates element ids AND dependent local-style
  ids (`e-<newElementId>-<rand>`) on every save. The S02 round-trip is asserted by
  structure + id_map, never by a hardcoded id.
- **[S02]/[C2] template round-trip.** `hero-section.composite` was run through the
  full `save_item → get_data → process_global_styles(match_site) → Document::save`
  path (the two-step insert, not `save_item` alone) and survives with REMAPPED
  element ids + REMAPPED local-style ids, structure + all local styles + the
  global-class ref intact, and the relation merging with NO orphan/dup (Q01
  self-check, 14/14 PASS).
- **§4 pre-filter meta-invariant.** `prefilter.verdict:accept ⇒ expect.valid:true`;
  `reject ⇒ expect.valid:false`; `defer` imposes no constraint. The TS pre-filter
  is a STRUCTURAL pre-filter: it authoritatively decides only R1/R3/R4/R7/R9 and
  the typed-envelope shape; everything else (enums, conditional/Union/free-string
  props, registered-type/R2) is `defer`red to PHP. A fixture is `reject` ONLY when
  the pre-filter structurally rejects it (so the §4 subset test stays green against
  the real pre-filter); the F06 loader skips authoring-schema validation for
  `reject` fixtures (`fixture-loader.ts:206-230`).
- **`requires` gates.** v4 fixtures gate on `e_atomic_elements`; design fixtures on
  `e_classes` / `e_variables`. v3 fixtures have EMPTY `requires.experiments` so the
  corpus is green (unmet ⇒ skipped, not failed) on free-only / atomic-off installs.

## v4 — valid (`v4/valid/`) [one+ per atomic widget, SUPPLEMENT §B.2]

| file                             | widget / scenario                              | verdict | prefilter |
| -------------------------------- | ---------------------------------------------- | ------- | --------- |
| `e-heading.basic.json`           | `e-heading` — h1, html-v3 title, 1 local style | valid   | defer     |
| `e-paragraph.basic.json`         | `e-paragraph` — p, html-v3 w/ inline tags      | valid   | defer     |
| `e-button.with-link.json`        | `e-button` — html-v3 text + link (url)         | valid   | defer     |
| `e-image.id-only.json`           | `e-image` — id-only image-src (R9 honored)     | valid   | defer     |
| `e-div-block.flex-row.json`      | `e-div-block` — flex row + 2 atomic children   | valid   | defer     |
| `e-flexbox.column.json`          | `e-flexbox` — flex column + 1 atomic child     | valid   | defer     |
| `hero-section.composite.json`    | composite hero (M1) — global + 4 local styles  | valid   | defer     |
| `styles.states-breakpoints.json` | full StyleState set + desktop/tablet/mobile    | valid   | defer     |

> Coverage note: the atomic widgets without a dedicated VALID tree fixture here
> (`e-svg`, `e-divider`, `e-youtube`, `e-self-hosted-video`, the `e-tabs`/Pro
> `e-form` families) have committed `get_props_schema()` drift baselines under
> `../schemas/` (WP-Q02). Q01 covers the load-bearing authoring widgets + the
> two atomic container types (`e-div-block`, `e-flexbox`); the Pro form family is
> gated behind `requires.pro` and owned by the Pro vertical (no file overlap).

## v4 — invalid (`v4/invalid/`) [one per failure-mode error code]

| file                                    | failure mode                          | expect.errors (PHP set)                              | prefilter |
| --------------------------------------- | ------------------------------------- | ---------------------------------------------------- | --------- |
| `e-heading.bad-tag-enum.json`           | tag value outside [h1..h6]            | `ATOMIC_SETTINGS_INVALID`                            | defer     |
| `e-button.missing-required-prop.json`   | html-v3 `text` omits `content`        | `ATOMIC_SETTINGS_INVALID`                            | defer     |
| `e-div-block.image-src-id-and-url.json` | image-src has BOTH id and url         | `IMAGE_SRC_XOR_VIOLATION`, `ATOMIC_SETTINGS_INVALID` | reject    |
| `local-style.id-not-in-classes.json`    | styles-map id not mirrored in classes | `LOCAL_STYLE_UNLINKED`                               | reject    |
| `duplicate-element-id.json`             | two nodes share an element id         | `DUPLICATE_ELEMENT_ID`                               | reject    |
| `unknown-widget-type.json`              | unregistered atomic widgetType        | `UNKNOWN_WIDGET_TYPE`                                | reject    |

> `e-div-block.image-src-id-and-url` returns BOTH codes from `dry_run` (the
> structural R9 check AND the Props_Parser both reject the malformed image-src);
> `expect.errors` is an order-independent SET (`§3.2.d`).
> `unknown-widget-type` is `reject` because an `e-foo` unknown cannot pass the
> closed-enum authoring schema (so it can't be `defer`); the node also carries an
> orphan local style so the pre-filter (which has no R2 check) rejects via R4 —
> both sides agree the tree is INVALID, and the AUTHORITATIVE PHP error set is the
> single `UNKNOWN_WIDGET_TYPE`. See its `_comment` for the full rationale.

## v3 — classic fallback (`v3/valid/`, `v3/invalid/`)

| file                              | scenario                                 | verdict                         | notes                                                            |
| --------------------------------- | ---------------------------------------- | ------------------------------- | ---------------------------------------------------------------- |
| `valid/heading.basic.json`        | classic `heading` — flat scalar settings | valid                           | no envelopes/styles                                              |
| `valid/container.flex.json`       | classic `container` + classic heading    | valid                           | flat controls, nesting                                           |
| `invalid/unknown-widgettype.json` | classic widget, unregistered type        | invalid (`UNKNOWN_WIDGET_TYPE`) | legacy unknowns DROP on save (not throw); dry_run still flags it |

## design — diff-PUT + variables batch (`design/`)

`kind:design` fixtures carry the EXACT REST request body in `settings` (the only
free-form object slot in the locked envelope). They are NOT run through
`Validator::dry_run` (that is for `kind:tree`); the design-write suite asserts the
body against the REST contract and the loader gates them by `requires`.

| file                              | shape (10-rest-api.md)                                                                                                                                                                                            | requires      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `global-classes.upsert-diff.json` | §4.2 diff-PUT `{context,changes{added,deleted,modified,order},items,order,op_id}` — items=touched-only, order=full final list, explicit deletes, ≤1000 budget, admin-only `elementor_global_classes_update_class` | `e_classes`   |
| `variables.batch.json`            | §4.4 batch `{watermark,operations[create/update/delete/reorder],op_id}` — watermark REQUIRED (stale ⇒ WATERMARK_STALE), all 3 var types FREE, ≤1000 budget                                                        | `e_variables` |

> The `design/` directory also holds `page-settings.merge-regression.json`
> (WP-F06's [S04/C3/R3] settings deep-merge regression seed — NOT a Q01 file).

## Verification (how each verdict was established)

1. Every `tree[]` round-tripped through the live companion `Validator::dry_run()`
   (web-server uid, Elementor 4.1.1) — `expect.valid` + the `expect.errors` SET
   equal what the validator actually returns (order-independent, `§3.2.d`).
2. Every file validated against the envelope schema (`§2`) AND each `tree[]` node
   against WP-F03's `element-node.schema.json` (skipped for `reject` fixtures,
   which carry deliberately schema-malformed trees).
3. The §4 pre-filter subset + corpus meta-invariant asserted by
   `packages/server/src/test-harness/prefilter-subset.test.ts` (green).
4. `hero-section.composite` additionally verified through the [S02]/[C2] template
   round-trip (`save_item → get_data → process_global_styles → save`) with id
   remap + relation merge, 14/14 assertions PASS.
