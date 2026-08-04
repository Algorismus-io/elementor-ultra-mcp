# Schema-drift baselines (WP-Q02)

These are the **committed, normalized snapshots** of the LIVE post-filter
`get_props_schema()` for every supported NON-Pro atomic widget, plus the atomic
`Style_Schema::get()`. They are the reference the schema-drift guard
(`packages/server/src/test-harness/schema-drift.test.ts`, `pnpm test:drift`)
diffs the live install against, so an Elementor version bump is caught at CI —
not at a customer save (`spec/contracts/14-fixtures-harness.md §5`, LOCKED).

Captured against the pinned **Elementor 4.1.1 + Elementor Pro 4.1.0** dev site
(V4 experiments `e_atomic_elements` / `e_classes` / `e_variables` active). Source:
`get_props_schema()` post-filter (`has-atomic-base.php:310-321`) — NOT
`define_props_schema()`; the Style-Schema is `Style_Schema::get()`
(`styles/style-schema.php`, merged from 10 groups via the
`elementor/atomic-widgets/styles/schema` filter).

## What a baseline contains (normalization — `§5 step 3`)

Each file is the output of `normalizeSchema()`
(`packages/server/src/test-harness/schema-normalize.ts`), which reduces the raw
`Prop_Type::jsonSerialize()` to the **contract surface only** and makes it
byte-diffable:

- **KEPT:** prop names (object keys), `$$type` / `key` discriminators, enum
  members (`settings.enum`), unit presets (`settings.available_units`), required
  / `dependencies` flags, union `prop_types`, and `default` values (a default
  change IS contract drift).
- **STRIPPED:** volatile human-facing fields (`meta` — labels/descriptions) and
  volatile runtime fields (`initial_value`); structural noise (`dependencies:null`,
  empty `settings`, `default:null`) is dropped so a non-semantic serialization
  tweak does not register as drift.
- **SORTED:** every object's keys lexicographically; array element ORDER is
  preserved (a reordered enum/unit list is real, reviewable drift).

`serializeNormalizedSchema()` emits 2-space-indented JSON with a trailing
newline, so two equal schemas serialize to identical bytes. The committed files
are then run through repo Prettier (which collapses short arrays) for
`format:check` cleanliness; this is purely cosmetic — the drift test PARSES both
the committed baseline and the live fetch and diffs them STRUCTURALLY
(`diffSchemas`), so the on-disk whitespace never affects the verdict. The
regeneration script (`fixtures:snapshot-schemas`, WP-F06) must likewise pipe its
output through Prettier so a no-change regen produces an empty PR diff.

## Pro-injected props (`display-conditions`)

The committed baselines were captured on a **Pro-active** site, so every widget
baseline includes the Pro-injected `display-conditions` prop (injected via
`elementor/atomic-widgets/props-schema` by
`elementor-pro/.../atomic-widgets/module.php`). The drift test treats
`display-conditions` as **Pro-gated**: on a Pro-absent wp-env it is ignored on
BOTH sides so the FREE leg stays green; on a Pro wp-env it is diffed normally.
The Pro `e-form` family (`e_pro_atomic_form`) has **no** committed baseline here —
its drift leg is gated behind `requires.pro` and snapshotted only on a Pro
install (`14-fixtures-harness.md §5`, ticket Detailed Requirements #1).

## Baselines (16)

| file                              | element type          | props | source                         |
| --------------------------------- | --------------------- | ----: | ------------------------------ |
| `e-heading.schema.json`           | `e-heading`           |     7 | `atomic-heading.php`           |
| `e-paragraph.schema.json`         | `e-paragraph`         |     7 | `atomic-paragraph.php`         |
| `e-button.schema.json`            | `e-button`            |     7 | `atomic-button.php`            |
| `e-image.schema.json`             | `e-image`             |     6 | `atomic-image.php`             |
| `e-div-block.schema.json`         | `e-div-block`         |     6 | `div-block.php`                |
| `e-flexbox.schema.json`           | `e-flexbox`           |     6 | `flexbox.php`                  |
| `e-svg.schema.json`               | `e-svg`               |     6 | `atomic-svg.php`               |
| `e-divider.schema.json`           | `e-divider`           |     4 | `atomic-divider.php`           |
| `e-youtube.schema.json`           | `e-youtube`           |    15 | `atomic-youtube.php`           |
| `e-self-hosted-video.schema.json` | `e-self-hosted-video` |    16 | `atomic-self-hosted-video.php` |
| `e-tabs.schema.json`              | `e-tabs`              |     5 | `atomic-tabs.php`              |
| `e-tabs-menu.schema.json`         | `e-tabs-menu`         |     4 | `atomic-tabs-menu.php`         |
| `e-tab.schema.json`               | `e-tab`               |     4 | `atomic-tab.php`               |
| `e-tabs-content-area.schema.json` | `e-tabs-content-area` |     4 | `atomic-tabs-content-area.php` |
| `e-tab-content.schema.json`       | `e-tab-content`       |     5 | `atomic-tab-content.php`       |
| `style-schema.json`               | (atomic Style-Schema) |    71 | `styles/style-schema.php`      |

Each widget baseline carries the always-injected `classes` (`Classes_Prop_Type`,
default `[]`), `attributes` (`Attributes_Prop_Type`), and `_cssid` (string,
`Overridable::ignore`) props in addition to its authorable settings (§B.2). The
drift test cross-checks these against the TS pre-filter's hardcoded structural
expectations (`§5` last line).

## How to regenerate (intentional Elementor bump — manual + reviewed)

The drift job **NEVER** auto-updates these baselines (`§5`). When you
intentionally bump the pinned Elementor / Pro version, regenerate them with the
manual, reviewed script (owned by WP-F06):

```sh
pnpm fixtures:snapshot-schemas
```

That script fetches the LIVE schemas from the pinned wp-env, runs them through
`normalizeSchema()`, and rewrites every `schemas/*.schema.json` + `style-schema.json`.
The resulting **PR diff is the human gate**: review the added/removed/changed
props and update the TS pre-filter's hardcoded expectations in lock-step before
merging (otherwise the pre-filter cross-check in `schema-drift.test.ts` fails).

The schema-drift test reports drift as a readable per-widget delta
(`added props [...]; removed props [...]; changed props [...]`) so a maintainer
can tell at a glance whether to regenerate (intentional) or investigate
(unexpected upstream change).
