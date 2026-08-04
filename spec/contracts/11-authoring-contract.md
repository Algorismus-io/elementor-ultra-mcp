# Contract 11 — Element Authoring Contract (FROZEN)

> Status: **FROZEN**. This is the canonical JSON our MCP emits and edits. **V4 atomic is the
> primary target; V3 classic is the fallback.** New pages default to V4 atomic and fall back to V3
> when atomic is inactive (probe `elementor.site.capabilities`).
>
> **The PHP `dry_run` endpoint (WP-P03) is the SINGLE SOURCE OF TRUTH for validity.** The TS
> validator (WP-T / `authoring/prefilter.ts`) is a CHEAP STRUCTURAL PRE-FILTER ONLY — it never
> decides validity on the critical path. Every WRITE pipeline ALWAYS round-trips through PHP
> `dry_run` before commit.
>
> Grounded in: RESEARCH.md §2.1 (data model), §4 (authoring contract), §6.6 (fidelity limits),
> §7 (safety); SUPPLEMENT.md §B.1 (prop-type catalog), §B.2 (per-widget props), §B.3 (Style-Schema +
> no-native-expression list). Source citations are `path:line` relative to `plugins/elementor`
> (free) and `plugins/elementor-pro` (Pro).

## 1. Companion JSON Schemas (consume these)

The machine-readable form of this contract lives under `spec/contracts/schemas/`. WP-F03
implements the TS types from them; the TS pre-filter and PHP both consume them.

| Schema file | Defines | TS type names (WP-F03) |
|---|---|---|
| `schemas/atomic-prop-types.schema.json` | typed-envelope `{$$type,value,disabled?}` catalog | `TypedValue`, plus per-`$$type` members |
| `schemas/style-variant.schema.json` | atomic style object + variants | `StyleDefinition`, `StyleVariant`, `StyleMeta` |
| `schemas/element-node.schema.json` | atomic + classic nodes | `ElementNode`, `AtomicContainerNode`, `AtomicWidgetNode`, `ClassicNode` |
| `schemas/page-tree.schema.json` | document tree read/write envelope | `PageTree`, `PageTreeRead`, `PageTreeWrite` |
| `schemas/diff.schema.json` | structured diff + dry-run result + coverage report | `Diff`, `NodeChange`, `DryRunResult`, `ValidationError`, `CoverageReport` |

**Frozen TS type-name set** (downstream MUST reuse exactly):
`TypedValue`, `Size`, `Dimensions`, `Classes`, `Link`, `ImageSrc`, `Image`, `HtmlV3`,
`GlobalVariableRef`, `StyleDefinition`, `StyleVariant`, `StyleMeta`, `BreakpointKey`, `StyleState`,
`ElementNode`, `AtomicContainerNode`, `AtomicWidgetNode`, `ClassicNode`, `AtomicNode`
(= `AtomicContainerNode | AtomicWidgetNode`), `ClassicNode`, `PageTree`, `PageTreeRead`,
`PageTreeWrite`, `Generation`, `PageSettings`, `Diff`, `NodeChange`, `DryRunResult`,
`ValidationError`, `CoverageReport`.

## 2. The two coexisting node schemas

Two node schemas coexist in the SAME tree (`core/base/document.php`; RESEARCH.md §2.1). A subtree MAY
mix generations but nesting must be tested (rule R6 below).

- **V4/atomic** (`e-*` types): `settings` values are **typed envelopes**
  `{"$$type","value","disabled"?}` (`prop-types/concerns/has-generate.php:11-22`); node carries extra
  siblings `version`, `styles`, `editor_settings`, `interactions`, optional `origin_id`. Styling is via
  the per-element `styles` map (local classes) + referenced global classes — **not** control selectors.
- **V3/classic** (`section`/`column`/`container` + classic widgets): `settings` is a FLAT assoc array
  of scalar/object control values; CSS is driven by each control's `selectors`.

### 2.1 V4 atomic container (preferred)

Extends `Atomic_Element_Base`; serializes **WITHOUT** `widgetType`.

    {
      "id": "abc1234",
      "elType": "e-div-block",
      "version": "0.0",
      "settings": {
        "tag": {"$$type":"string","value":"section"},
        "classes": {"$$type":"classes","value":["g-brandcard","e-abc1234-7f3a9c2"]}
      },
      "styles": {
        "e-abc1234-7f3a9c2": {
          "id":"e-abc1234-7f3a9c2","type":"class","label":"local",
          "variants":[ { "meta":{"breakpoint":"desktop","state":null},
            "props":{ "display":{"$$type":"string","value":"flex"},
                      "padding":{"$$type":"dimensions","value":{
                        "block-start":{"$$type":"size","value":{"size":24,"unit":"px"}}}} } } ]
        }
      },
      "editor_settings": [],
      "interactions": [],
      "elements": [ /* atomic children */ ]
    }

### 2.2 V4 atomic widget (preferred)

Extends `Atomic_Widget_Base`; serializes `{elType:'widget', widgetType:'e-heading'}`.

    {
      "id": "hd00001",
      "elType": "widget",
      "widgetType": "e-heading",
      "version": "0.0",
      "settings": {
        "tag": {"$$type":"string","value":"h1"},
        "classes": {"$$type":"classes","value":[]},
        "title": {"$$type":"html-v3","value":{"content":{"$$type":"string","value":"Welcome"},"children":[]}}
      },
      "styles": {}, "editor_settings": {"title":"My Heading"}, "interactions": [], "elements": []
    }

Note: the real fetched schema for any atomic widget also contains **`_cssid`** (auto-injected,
`has-atomic-base.php:310-321` — `elements/base/has-atomic-base.php` is the verified path). Do NOT
author `_cssid`, but **tolerate it on round-trip**.

### 2.3 V3 classic node (fallback)

    { "id":"a1b2c3d", "elType":"widget", "widgetType":"heading",
      "settings":{ "title":"Hello", "header_size":"h1", "align":"center",
        "align_tablet":"left", "title_color":"#222" }, "elements":[] }

Classic rules: scalars for `Base_Data_Control`; objects for `Base_Multiple`
(`media`,`url`,`icons`,`slider`,`dimensions`,`box_shadow`); switcher = `"yes"`/`""`; responsive
overrides use **suffix keys** `_tablet`/`_mobile` (never nested objects); group controls expand to
flat prefixed keys (`typography_font_size`, `border_width`, double `button_box_shadow_box_shadow`);
dynamic via `settings.__dynamic__`; globals via `settings.__globals__`. **Emit only non-default keys.**

## 3. The typed-envelope rule (universal, atomic)

Every atomic prop value = `{"$$type":"<key>","value":<payload>,"disabled"?:true}`, where `$$type`
MUST equal the prop type's `get_key()` (`has-transformable-validation.php:11-25`). Three base kinds:
PLAIN, ARRAY (value = plain array of wrapped items), OBJECT (value = assoc array of wrapped fields).
**UNION is NOT itself wrapped** — emit the chosen member's own `{$$type,value}` envelope
(`union-prop-type.php:74-96`). **`classes` value is a BARE string array** (no inner wrapping).

### 3.1 Prop-type catalog (full, from SUPPLEMENT §B.1)

The full catalog is encoded in `schemas/atomic-prop-types.schema.json`. Quick reference of the
load-bearing shapes:

| `$$type` | kind | `value` |
|---|---|---|
| `string` / `color` | plain | `"text"` / `"#375EFB"` |
| `number` / `boolean` | plain | `12` / `true` |
| `classes` | plain | `["g-abc","e-id-xyz"]` (BARE array; each `/^[a-z][a-z-_0-9]*$/i`, `classes-prop-type.php:22`) |
| `size` | object | `{"size":16,"unit":"px"}` (auto⇒size null; custom⇒string) |
| `dimensions` | object | `{"block-start":<size>,"inline-end":<size>,"block-end":<size>,"inline-start":<size>}` |
| `link` | object | `{"destination":<url\|query envelope>,"isTargetBlank":<bool>,"tag":{"$$type":"string","value":"a"}}` |
| `image` | object | `{"src":<image-src>,"size":{"$$type":"string","value":"full"}}` |
| `image-src` | object | **`id` XOR `url`, NEVER both** (`image-src-prop-type.php:36-44`) |
| `html-v3` | object | `{"content":{"$$type":"string","value":"My <b>Title</b>"},"children":[]}` (inline-tag allowlist only) |
| `background` | object | `{"color":{"$$type":"color","value":"#000"},…}` (image-overlay sub-schema runtime-extended) |
| `global-color/font/size-variable` | plain | `"<variable-id>"` → renders `var(--Label)` (all three FREE, `variables/hooks.php:48-51`) |

### 3.2 `image-src` is id-XOR-url (HARD rule)

`image-src-prop-type.php:36-44` validates `($has_id xor $has_url) && parent::validate_value`. Emit
**ID-only** for media in the WP library (preferred; sideload first via `media.sideload_url`),
**url-only** only for true externals. Never both, never neither.

    {"$$type":"image","value":{
      "src":{"$$type":"image-src","value":{
        "id":{"$$type":"image-attachment-id","value":123}
      }},
      "size":{"$$type":"string","value":"full"}
    }}

### 3.3 `html-v3` inline-only allowlist (HARD rule)

`html-v3-prop-type.php:82,91` runs `wp_kses` with the inline allowlist
**`b,i,em,u,a,del,span,strong,sup,sub,s`**. Everything else (`<br>`, `<mark>`, `<code>`, `<small>`,
`<font>`, lists, nested blocks, headings-in-paragraphs) is **silently stripped**. The normalizer MUST
promote block content to sibling element nodes BEFORE emitting `html-v3`; the fidelity report MUST
diff pre/post inner markup and list stripped tags (`CoverageReport.stripped_text`).

## 4. Atomic element types (verified)

From `modules/atomic-widgets/elements/`:

- **Containers:** `e-div-block`, `e-flexbox`, `e-tabs`, `e-tabs-menu`, `e-tab`,
  `e-tabs-content-area`, `e-tab-content`.
- **Widgets:** `e-heading`, `e-paragraph`, `e-image`, `e-button`, `e-svg`, `e-youtube`, `e-divider`,
  `e-self-hosted-video`.
- **Forms (FREE containers):** `e-form`, `e-form-success-message`, `e-form-error-message`.
- **Pro fields (gated on `e_pro_atomic_form`):** `e-form-input`, `e-form-textarea`,
  `e-form-checkbox`, `e-form-radio-button`, `e-form-select`, `e-form-date-picker`,
  `e-form-time-picker`, `e-form-file-upload`, `e-form-label`, `e-form-submit-button`.

### 4.1 Per-widget authorable settings props (from SUPPLEMENT §B.2)

Every atomic widget ALSO carries auto-injected `_cssid` (ignorable), always-present `classes`
(default `[]`) + `attributes`, and — when Pro is active — `display-conditions` (injected via the
`elementor/atomic-widgets/props-schema` filter, absent from the free static schema). `get_props_schema()`
(post-filter) is authoritative — fetch live via `elementor.schema.widget`.

| element type | authorable props (name → `$$type` → default/enum) | src |
|---|---|---|
| `e-heading` | tag:string enum[h1..h6] def h2; title:html-v3 def "This is a title"; link:link | `atomic-heading.php:48` |
| `e-paragraph` | paragraph:html-v3 def "Type your paragraph here"; tag:string enum[p,span] def p; link:link | `atomic-paragraph.php:50` |
| `e-button` | text:html-v3 def "Click here"; link:link; tag:string def button | `atomic-button.php:48` |
| `e-image` | image:image (size 'full'); link:link | `atomic-image.php:46` |
| `e-svg` | svg:svg-src; link:link | `atomic-svg.php:49` |
| `e-divider` | classes/attributes only | `atomic-divider.php:48` |
| `e-youtube` | source:string; start/end:string; autoplay/mute/loop/lazyload:boolean false; player_controls:boolean true; captions/privacy_mode:boolean false; rel:boolean true | `atomic-youtube.php` |
| `e-self-hosted-video` | source:video-src; autoplay/playsinline/mute/loop:boolean false; controls:boolean true; preload:enum[auto,metadata,none] def metadata; poster_enabled:boolean false; poster:image | `atomic-self-hosted-video.php` |
| `e-div-block` | tag:string enum[div,header,section,article,aside,footer,a,button] def div; link:link | `div-block.php:52` |
| `e-flexbox` | tag enum (same) def div; link:link | `flexbox.php:54` |
| `e-form` (FREE) | form-name:string def 'Form'; form-state:enum[default,success,error] def default; actions-after-submit:string-array def ['email']; submissions_metadata:string-array; email:email; webhook_url:string '' | `atomic-form.php` |
| `e-form-submit-button` | text:html-v3 def 'Submit' (author the `{content,children}` form); tag:string def button | `submit-button.php` |

(Full table for tabs/forms families in SUPPLEMENT §B.2. Always reconcile against live `schema.widget`.)

## 5. The styles array vs settings distinction

**CSS lives on a separate `styles` map on the element root, NOT in `settings`**
(`atomic-widget-base.php`; raw at `has-atomic-base.php:229`). `settings.classes` (a `classes`
envelope) holds the class ids that link the element to its style objects.

A style object = `{id, type:'class', label, variants:[...]}` (`styles/style-definition.php:36-39`).
A variant = `{meta:{breakpoint,state}, props:{<css-prop>:<typedValue>}, custom_css?:{raw}|null}`
(`styles/style-variant.php:38-42`). See `schemas/style-variant.schema.json`.

### 5.1 Local-style id mirroring into `classes` (HARD rule)

A **local style** must (a) appear in the element's `styles` map keyed by a unique id (convention
`e-<elementId>-<7hex>`) AND (b) have that id present in the element's `settings.classes.value` array.
If the id is missing from `classes`, the style **silently detaches** and never renders. A **global
class** is referenced by id only (data lives in the `e_global_class` CPT, written via the
`Global_Classes_Repository` — never raw meta).

### 5.2 Style-Schema native props + the no-native-expression list (SUPPLEMENT §B.3)

Only `Style_Schema`-valid CSS props (`styles/style-schema.php`) become native style props; probe the
live, flat `css-prop-name → Prop_Type` map via `elementor.schema.styles`. Valid variant **states**
(`styles/style-states.php:6-12`): `null`(normal), `hover`, `active`, `focus`, `focus-visible`,
`checked`, `e--selected`. State lives on `meta`, never on a prop. Breakpoints on `meta.breakpoint`.

**CSS props with NO native expression → route down the fallback ladder (§9):**

- **Absent from the schema entirely:** `grid-template-areas`, named grid lines,
  `place-items`/`place-content`/`place-self`, `text-shadow` (only `box-shadow`), `writing-mode`,
  `white-space`, `word-break`, `overflow-x/-y` (only combined `overflow`), `list-style*`, `table-*`,
  `float`/`clear`, `visibility`, `pointer-events`, `user-select`, `backface-visibility`,
  `will-change`, `scroll-snap-*`, `container-*`, authored CSS custom properties (`--x`).
- **Enum-constrained (non-listed value drops):** `font-weight` (numeric ≠ 100-steps, e.g. 350),
  `display` (no `table`/`list-item`/`inline-table`), `justify-content`/`align-items`/`justify-items`/
  `align-self`/`align-content` (no `inherit`/`safe center`), `text-transform`, `mix-blend-mode`,
  `border-style`, `cursor` (only `pointer`).
- **Typed-object props (raw shorthand rejected — must decompose exactly):** `transform`,
  `transition`, `filter`/`backdrop-filter`, `box-shadow`, `background` (gradients/multi-layer),
  `border-radius`/`border-width` per-corner.
- **Free-string props the TS pre-filter cannot fully validate** (`is_string` only): `aspect-ratio`,
  `font-family`, `text-decoration`, `grid-template-columns/-rows`, `content`, `clip-path`.

## 6. Dynamic binding — both encodings

- **V3 classic:** `settings.__dynamic__[<control>] = '[elementor-tag id="<id>" name="<tag_name>"
  settings="<urlencoded JSON_FORCE_OBJECT>"]'` (`core/dynamic-tags/manager.php:141-142`). Empty
  settings encode as `%7B%7D` (urlencoded `{}`), **NOT** empty string. `id` = a random 7-char value.
  Only controls declared `dynamic=>['active'=>true]` accept it, and the tag's category must intersect
  the control's `dynamic.categories`.
- **V4 atomic:** dynamic is a typed-envelope prop value — exact `$$type`/payload is
  **UNVERIFIED — needs spike** (RESEARCH.md §10 OQ#7). Discover at runtime via `schema.widget`
  (flags dynamic-capable props) and `dynamic.get_tag_schema`.

## 7. V3 globals binding

`settings.__globals__[<control>] = 'globals/colors?id=<_id>'` (typography group key
`typography_typography`, value `'globals/typography?id=<_id>'`). Standard kit color ids:
`primary`/`secondary`/`text`/`accent`.

## 8. Validation rules (PHP `dry_run` authoritative; TS pre-filters)

Numbered, frozen. The TS pre-filter (`authoring/prefilter.ts`) checks R1, R3, R4, R7, R9 structurally;
PHP `dry_run` decides everything (R2, R5, R8) authoritatively.

1. **R1** Every node has `id` (non-empty string) and `elType`.
2. **R2** `widgetType`/`elType` is a **registered type** on the target site (query
   `schema/registered-types`); else legacy nodes are silently DROPPED, atomic nodes THROW
   (`has-atomic-base.php:97,113`).
3. **R3 — ID uniqueness** across the whole tree and against existing document ids on merge. Mint with
   `substr(strtolower(dechex(wp_rand(0,PHP_INT_MAX))),0,7)`, dedupe against a live set. Elementor does
   NO server-side uniqueness check; duplicates collide on `.elementor-element-<id>` selectors.
4. **R4 — Local style ids** unique AND mirrored into the owning element's `classes` prop (§5.1).
5. **R5** Atomic settings/styles validated by **PHP `dry_run`** (the real save throws). TS does a
   cheap pre-filter against fetched `get_props_schema()` + `Style_Schema` but is **never
   authoritative**; conditional validity (`Dependency_Manager`, Union/Span/Flex props) is PHP-side.
6. **R6** One generation per node; subtrees may mix but test nesting.
7. **R7** `classes` names match `/^[a-z][a-z-_0-9]*$/i`; global-class labels 2–50 chars, no spaces,
   no leading digit/`--`/`-digit`, not reserved `container`.
8. **R8** Only `Style_Schema`-valid CSS props become native style props; others → fallback ladder (§9).
9. **R9** `image-src` honors id-XOR-url (§3.2).

### 8.1 ID-uniqueness handling

- TS mints IDs; PHP exposes `ids/validate` (used-id set for a document) and `ids/remap` (regenerates
  colliding ids + rewrites local-style back-references, mirroring `styles-ids-modifier.php`) before
  insert.
- On clone/insert of library blocks, **replace all ids** (mirror Elementor export behavior,
  `document.php:1641-1654`) to avoid cross-document collision.

## 9. Fallback ladder (per unmapped declaration / node)

Per RESEARCH.md §6.4. Recorded per-node in `CoverageReport.fallbacks[].tier`.

1. **Native style prop** (in `Style_Schema`) — preferred.
2. **Local style variant** (element-scoped, single use).
3. **Global class** (shared, ≥2 uses).
4. **Pro `custom_css.raw`** on a variant — *licensed; stripped on free*
   (`atomic-widget-styles.php:94-114`). Only if Pro active.
5. **`html` widget dump** — last resort; requires `can_use_custom_html`; subject to `wp_kses_post`
   for non-admins. Flag loudly in the report.

Whole-node ladder: atomic target → V3 classic widget → generic `e-div-block`/`container` + styles →
html widget.

## 10. Persistence & CSS priming invariants (cross-reference)

- **NEVER raw-write `_elementor_data`.** All writes go through `Document::save(['elements','settings'])`
  via the companion plugin (WP-P02). The dry_run validator (WP-P03) gates every commit.
- **V4 atomic CSS does NOT render on a headless save.** A `prime-css` step (WP-P04 / S1) is MANDATORY
  after any atomic write. Atomic styles render only on frontend hooks
  (`atomic-styles-manager.php:47-150`); `Post_CSS::create($id)->update()` is the V3 path and no-ops
  for atomic pages. Any WP that authors atomic styles depends on the prime-css WP + WP-S01.

## 11. Round-trip & content-filter caveats

- Atomic widgets export their own LOSSY markdown — markdown round-trip is a coarse text-presence check
  only; prefer visual diff (RESEARCH.md §6.8).
- **content-sanitizer rewrites `title` for NON-admins** (admins exempt, `content-sanitizer/module.php:26`);
  non-admin saves also `wp_kses_post` strip script/style/iframe/data-* (`document.php:841`). **Run as
  admin** for full fidelity. Round-trip identity tests must account for these so diffs don't show
  spurious changes.
