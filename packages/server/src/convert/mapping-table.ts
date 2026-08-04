/**
 * WP-H01 — the HTML role → Elementor element-type mapping-table reference (the single source of truth
 * used by every downstream conversion stage, RESEARCH.md §6.2 + SUPPLEMENT §C.4).
 *
 * PURE module: NO Playwright, NO `fs`, NO WP client, NO tool runtime — deterministic given inputs, so
 * it is testable in isolation and reusable by both `convert.html_to_tree` (TS-only) and the corpus
 * harness. Resolution logic lives ONLY in `mapRole`/`containerTagFor`; `MAPPING_TABLE` is plain data
 * that reads like the §6.2 table.
 *
 * Atomic types verified present in Elementor 4.1.x (`11-authoring-contract.md §4`): containers
 * `e-div-block, e-flexbox, e-tabs, e-tabs-menu, e-tab, e-tabs-content-area, e-tab-content`; widgets
 * `e-heading, e-paragraph, e-image, e-button, e-svg, e-youtube, e-divider, e-self-hosted-video`; FREE
 * form containers `e-form, e-form-success-message, e-form-error-message`; Pro form fields `e-form-*`
 * gated on `e_pro_atomic_form`. There is NO `e-accordion`, NO `e-list`, NO `e-table`, NO `e-icon-list`.
 */

import type { MappingResult, SemanticRole } from './types.js';

/* ─────────────────────────── Container tag enum (div-block.php:78) ──────────────────────────── */

/**
 * The `e-div-block`/`e-flexbox` `tag` prop enum (`div-block/div-block.php:78`, `flexbox/flexbox.php`,
 * `11-authoring-contract.md §4.1`). Any source tag is clamped to this set; out-of-set → `div`.
 */
const CONTAINER_TAG_ENUM = [
  'div',
  'header',
  'section',
  'article',
  'aside',
  'footer',
  'a',
  'button',
] as const;

type ContainerTag = (typeof CONTAINER_TAG_ENUM)[number];

const CONTAINER_TAG_SET: ReadonlySet<string> = new Set<string>(CONTAINER_TAG_ENUM);

/**
 * Pick the `e-div-block`/`e-flexbox` `tag` enum value for a container, from its source tag. A `<nav>`
 * has no enum member, so it degrades to `div` (the nav SEMANTICS live in the role/Pro path, not the
 * container tag). Unknown / out-of-enum → `div` (`div-block.php:79` default).
 */
export function containerTagFor(_role: SemanticRole, sourceTag: string): ContainerTag {
  const lower = sourceTag.toLowerCase();
  return CONTAINER_TAG_SET.has(lower) ? (lower as ContainerTag) : 'div';
}

/* ─────────────────────────── MappingRule (the §6.2 rows as data) ────────────────────────────── */

/**
 * One row of the RESEARCH.md §6.2 mapping table. `v4` is the atomic target; `v3` is the classic
 * fallback; `requires` declares the Pro/experiment preconditions `mapRole` checks against `MapContext`.
 * `tagFrom:'source'` ⇒ `mapRole` clamps the source tag via `containerTagFor`; `tagFrom:'fixed'` ⇒ use
 * `fixedTag` verbatim (e.g. `e-heading` carries the `h*` level, supplied by the caller's settings).
 */
export interface MappingRule {
  role: SemanticRole;
  v4: {
    elType: string;
    widgetType?: string;
    is_container: boolean;
    tagFrom?: 'source' | 'fixed';
    fixedTag?: string;
  };
  v3: {
    elType: string;
    widgetType?: string;
  };
  requires?: {
    pro?: boolean;
    experiment?: string;
  };
  notes: string;
}

/**
 * The FROZEN, ordered §6.2 mapping table (+ the SUPPLEMENT §C.4 `<details>/<summary>`→accordion row).
 * Plain data so it reads like the contract table. Every `SemanticRole` (except internal `unknown`,
 * which `mapRole` resolves to a generic block) has at least one rule.
 */
export const MAPPING_TABLE: ReadonlyArray<MappingRule> = [
  // <div>/<section>/<header>/<footer>/<article>/<aside> → e-div-block (tag from source) / container.
  {
    role: 'structural-block',
    v4: { elType: 'e-div-block', is_container: true, tagFrom: 'source' },
    v3: { elType: 'container' },
    notes: 'div/section/header/footer/article/aside → e-div-block; tag enum from source.',
  },
  // flex row wrapper → e-flexbox / container (flex).
  {
    role: 'flex-row',
    v4: { elType: 'e-flexbox', is_container: true, tagFrom: 'source' },
    v3: { elType: 'container' },
    notes: 'flex row-col wrapper → e-flexbox (flex-direction:row); V3 flex container.',
  },
  // flex column wrapper → e-flexbox / container (flex).
  {
    role: 'flex-col',
    v4: { elType: 'e-flexbox', is_container: true, tagFrom: 'source' },
    v3: { elType: 'container' },
    notes: 'flex row-col wrapper → e-flexbox (flex-direction:column); V3 flex container.',
  },
  // grid wrapper → e-div-block + grid props (Style_Schema grid is limited, §6.6) / container.
  {
    role: 'grid',
    v4: { elType: 'e-div-block', is_container: true, tagFrom: 'source' },
    v3: { elType: 'container' },
    notes:
      'grid → e-div-block + raw grid-template props (no areas/named lines, §6.6); V3 container.',
  },
  // <h1>–<h6> → e-heading / heading. tag (h1..h6) is supplied via settings_seed by the caller.
  {
    role: 'heading',
    v4: { elType: 'widget', widgetType: 'e-heading', is_container: false },
    v3: { elType: 'widget', widgetType: 'heading' },
    notes:
      'h1-h6 → e-heading; title=html-v3; a11y hierarchy lint (§6.5). V3 heading (header_size).',
  },
  // <p>, inline text block → e-paragraph / text-editor. Block children promoted out (§6.6).
  {
    role: 'text',
    v4: { elType: 'widget', widgetType: 'e-paragraph', is_container: false },
    v3: { elType: 'widget', widgetType: 'text-editor' },
    notes:
      'p / inline text block → e-paragraph (tag p/span); block children promoted. V3 text-editor.',
  },
  // <img> → e-image (image-src id-only after sideload) / image.
  {
    role: 'image',
    v4: { elType: 'widget', widgetType: 'e-image', is_container: false },
    v3: { elType: 'widget', widgetType: 'image' },
    notes: 'img → e-image (image-src id-only after media.sideload_url). V3 image.',
  },
  // <a class=button>/<button> → e-button (text+link) / button. Empty-name a11y lint.
  {
    role: 'button',
    v4: { elType: 'widget', widgetType: 'e-button', is_container: false },
    v3: { elType: 'widget', widgetType: 'button' },
    notes: 'a.button / button → e-button (text+link); empty-name a11y lint. V3 button.',
  },
  // Plain <a> (non-button) → styled e-div-block link container / V3 container. (Inline links inside
  // text runs stay in html-v3; this rule covers a link acting as a wrapping block.)
  {
    role: 'link',
    v4: { elType: 'e-div-block', is_container: true, tagFrom: 'fixed', fixedTag: 'a' },
    v3: { elType: 'container' },
    notes: 'wrapping <a> block → e-div-block tag=a (link applied); inline links stay in html-v3.',
  },
  // <hr> → e-divider / divider.
  {
    role: 'divider',
    v4: { elType: 'widget', widgetType: 'e-divider', is_container: false },
    v3: { elType: 'widget', widgetType: 'divider' },
    notes: 'hr → e-divider. V3 divider.',
  },
  // <svg>/icon font → e-svg / icon.
  {
    role: 'icon-svg',
    v4: { elType: 'widget', widgetType: 'e-svg', is_container: false },
    v3: { elType: 'widget', widgetType: 'icon' },
    notes: 'svg / icon font → e-svg. V3 icon.',
  },
  // YouTube iframe → e-youtube / video.
  {
    role: 'media-embed-youtube',
    v4: { elType: 'widget', widgetType: 'e-youtube', is_container: false },
    v3: { elType: 'widget', widgetType: 'video' },
    notes: 'YouTube iframe → e-youtube. V3 video.',
  },
  // <video> self-hosted → e-self-hosted-video / video.
  {
    role: 'media-embed-video',
    v4: { elType: 'widget', widgetType: 'e-self-hosted-video', is_container: false },
    v3: { elType: 'widget', widgetType: 'video' },
    notes: 'video self-hosted → e-self-hosted-video. V3 video.',
  },
  // tab UI → e-tabs > (e-tabs-menu>e-tab*) + (e-tabs-content-area>e-tab-content*) / tabs|nested-tabs.
  // tab & content counts MUST match — only mapped when ctx.tab_pairing_ok (see mapRole).
  {
    role: 'tabs',
    v4: { elType: 'e-tabs', is_container: true },
    v3: { elType: 'widget', widgetType: 'nested-tabs' },
    notes:
      'tab UI → e-tabs > (e-tabs-menu>e-tab*) + (e-tabs-content-area>e-tab-content*); ' +
      'tab & content counts MUST match. V3 tabs/nested-tabs.',
  },
  // an individual tab (menu item) → e-tab.
  {
    role: 'tab',
    v4: { elType: 'e-tab', is_container: true },
    v3: { elType: 'container' },
    notes: 'single tab (menu item) → e-tab inside e-tabs-menu. V3 container.',
  },
  // a tab content panel → e-tab-content.
  {
    role: 'tab-content',
    v4: { elType: 'e-tab-content', is_container: true },
    v3: { elType: 'container' },
    notes: 'tab content panel → e-tab-content inside e-tabs-content-area. V3 container.',
  },
  // <nav>/menu → (Pro) nav-menu widget bound to a WP menu term, OR e-div-block+e-button list / Pro
  // nav-menu. The Pro bound-widget path requires Pro; without it, the structural list is the fallback.
  {
    role: 'nav-menu',
    v4: { elType: 'e-div-block', is_container: true, tagFrom: 'fixed', fixedTag: 'div' },
    v3: { elType: 'widget', widgetType: 'nav-menu' },
    requires: { pro: true },
    notes:
      'nav/menu → (Pro) nav-menu widget bound to a WP menu term; ' +
      'without Pro, e-div-block + e-button list (mega-menu = inline items). V3 Pro nav-menu.',
  },
  // <form>+fields → e-form + e-form-* (Pro + e_pro_atomic_form) / Pro form widget. Gated.
  {
    role: 'form',
    v4: { elType: 'e-form', is_container: true },
    v3: { elType: 'widget', widgetType: 'form' },
    requires: { pro: true, experiment: 'e_pro_atomic_form' },
    notes: 'form → e-form + e-form-* (requires Pro + e_pro_atomic_form). V3 Pro form widget.',
  },
  // a single form field → e-form-* (Pro + e_pro_atomic_form). Concrete e-form-* type chosen by MAP
  // from the input kind; the rule pins the gating + the V3 fallback path.
  {
    role: 'form-field',
    v4: { elType: 'widget', widgetType: 'e-form-input', is_container: false },
    v3: { elType: 'widget', widgetType: 'form' },
    requires: { pro: true, experiment: 'e_pro_atomic_form' },
    notes:
      'form field → e-form-* (e-form-input default; MAP picks the concrete kind). ' +
      'Requires Pro + e_pro_atomic_form. Folds into the V3 Pro form widget on fallback.',
  },
  // <ul>/<ol> list → e-div-block + e-paragraph items / icon-list. NO atomic equivalent.
  {
    role: 'list',
    v4: { elType: 'e-div-block', is_container: true, tagFrom: 'fixed', fixedTag: 'div' },
    v3: { elType: 'widget', widgetType: 'icon-list' },
    notes: 'ul/ol → e-div-block + e-paragraph items (NO atomic list widget). V3 icon-list.',
  },
  // a single list item → e-paragraph inside the e-div-block list approximation.
  {
    role: 'list-item',
    v4: { elType: 'widget', widgetType: 'e-paragraph', is_container: false },
    v3: { elType: 'widget', widgetType: 'text-editor' },
    notes: 'li → e-paragraph item inside the e-div-block list approximation. V3 text-editor.',
  },
  // <table> → e-div-block grid approximation / html widget last resort. NO atomic equivalent.
  {
    role: 'table',
    v4: { elType: 'e-div-block', is_container: true, tagFrom: 'fixed', fixedTag: 'div' },
    v3: { elType: 'widget', widgetType: 'html' },
    notes: 'table → e-div-block grid approximation (NO atomic table). V3 html widget last resort.',
  },
  // <details>/<summary> → accordion (SUPPLEMENT §C.4). Elementor 4.1.x has NO atomic accordion widget,
  // so V4 is a styled-e-div-block approximation (clickable header block + content block). DOCUMENTED
  // LIMITATION: a structural approximation, not a 1:1 widget. V3 nested-accordion.
  {
    role: 'accordion',
    v4: { elType: 'e-div-block', is_container: true, tagFrom: 'fixed', fixedTag: 'div' },
    v3: { elType: 'widget', widgetType: 'nested-accordion' },
    notes:
      'details/summary → accordion. NO atomic accordion in 4.1.x → styled-e-div-block ' +
      'approximation (clickable header block + content block). DOCUMENTED LIMITATION. V3 nested-accordion.',
  },
  // a single accordion item → e-div-block (header + content) approximation.
  {
    role: 'accordion-item',
    v4: { elType: 'e-div-block', is_container: true, tagFrom: 'fixed', fixedTag: 'div' },
    v3: { elType: 'container' },
    notes:
      'accordion item → e-div-block (header + content) approximation. DOCUMENTED LIMITATION. ' +
      'V3 container.',
  },
];

/* ─────────────────────────── NO_ATOMIC_EQUIVALENT (whole-node ladder, §9) ───────────────────── */

/**
 * Roles with NO native V4 atomic widget — their V4 mapping is a structural-block APPROXIMATION (or a
 * V3 fallback per the §9 whole-node ladder). Consumers (STYLE-EXTRACT/ASSEMBLE) must treat these as
 * approximations, not 1:1 widgets. (`list`/`table` per §6.2; `accordion`/`accordion-item` per §C.4.)
 */
export const NO_ATOMIC_EQUIVALENT: ReadonlySet<SemanticRole> = new Set<SemanticRole>([
  'list',
  'table',
  'accordion',
  'accordion-item',
]);

/* ─────────────────────────── mapRole (context-aware resolution; never throws) ───────────────── */

/**
 * The MAP context `mapRole` resolves against (a subset of the live capabilities probe + per-node
 * signals MAP computes). Where the target requires Pro/experiments the context lacks, `mapRole`
 * returns the documented fallback or a structural-block approximation — it NEVER throws.
 */
export interface MapContext {
  pro_active: boolean;
  atomic_active: boolean;
  child_count: number;
  has_youtube: boolean;
  tab_pairing_ok: boolean;
}

/** A generic structural-block approximation (V4 `e-div-block`, V3 `container`) — the degrade target. */
function structuralBlock(tag: string): MappingResult {
  return {
    generation: 'v4',
    elType: 'e-div-block',
    is_container: true,
    tag,
    settings_seed: { tag },
    v3_fallback: { elType: 'container' },
  };
}

/** Build the V3-only result for a rule (used when atomic is inactive). */
function v3Result(rule: MappingRule): MappingResult {
  const result: MappingResult = {
    generation: 'v4',
    elType: rule.v3.elType,
    is_container: rule.v4.is_container && !rule.v3.widgetType,
    settings_seed: {},
    v3_fallback: { elType: rule.v3.elType },
  };
  if (rule.v3.widgetType !== undefined) {
    result.widgetType = rule.v3.widgetType;
    result.v3_fallback.widgetType = rule.v3.widgetType;
  }
  return result;
}

/** Build the native V4 result for a rule, attaching the resolved container `tag` when applicable. */
function v4Result(rule: MappingRule, sourceTag: string): MappingResult {
  const result: MappingResult = {
    generation: 'v4',
    elType: rule.v4.elType,
    is_container: rule.v4.is_container,
    settings_seed: {},
    v3_fallback: { elType: rule.v3.elType },
  };
  if (rule.v4.widgetType !== undefined) {
    result.widgetType = rule.v4.widgetType;
  }
  if (rule.v3.widgetType !== undefined) {
    result.v3_fallback.widgetType = rule.v3.widgetType;
  }
  // Containers carry a `tag` from the source (clamped) or a fixed value. Widgets do not.
  if (rule.v4.is_container) {
    let tag: string | undefined;
    if (rule.v4.tagFrom === 'source') {
      tag = containerTagFor(rule.role, sourceTag);
    } else if (rule.v4.tagFrom === 'fixed') {
      tag = rule.v4.fixedTag ?? 'div';
    }
    if (tag !== undefined) {
      result.tag = tag;
      result.settings_seed = { tag };
    }
  }
  return result;
}

/**
 * Resolve a `SemanticRole` + `MapContext` to an Elementor target. Context-aware and NEVER throws:
 *  - `unknown` → generic `e-div-block` structural block (degrade, never fail; §9 whole-node ladder).
 *  - `atomic_active:false` → the V3 fallback for every role.
 *  - `requires.pro` unmet → the documented structural fallback (e.g. nav-menu → e-div-block list).
 *  - `requires.experiment` unmet → the structural/V3 fallback.
 *  - `tabs` → only `e-tabs` when `tab_pairing_ok` (menu count == content count); else structural block.
 *
 * `sourceTag` lets containers clamp their `tag` enum from the source element (`containerTagFor`).
 */
export function mapRole(role: SemanticRole, ctx: MapContext, sourceTag = 'div'): MappingResult {
  // `unknown` always degrades to a generic structural block so the pipeline never throws (§9).
  if (role === 'unknown') {
    if (!ctx.atomic_active) {
      return {
        generation: 'v4',
        elType: 'container',
        is_container: true,
        settings_seed: {},
        v3_fallback: { elType: 'container' },
      };
    }
    return structuralBlock(containerTagFor('structural-block', sourceTag));
  }

  const rule = MAPPING_TABLE.find((r) => r.role === role);
  // Defensive: an unrecognized role degrades like `unknown` rather than throwing.
  if (rule === undefined) {
    return structuralBlock(containerTagFor('structural-block', sourceTag));
  }

  // Atomic inactive → V3 fallback for every role.
  if (!ctx.atomic_active) {
    return v3Result(rule);
  }

  // Pro required but absent → documented structural/V3 fallback (NOT the Pro widget).
  if (rule.requires?.pro === true && !ctx.pro_active) {
    // nav-menu degrades to the e-div-block + e-button list (a structural block here; ASSEMBLE fills
    // the e-button children). form/form-field degrade to a structural block (no atomic form path).
    return structuralBlock(containerTagFor(role, sourceTag));
  }

  // Experiment required but unsatisfied → structural fallback. The MapContext does not enumerate
  // arbitrary experiments; the only experiment-gated path here is the atomic form, which also
  // requires Pro — so an unmet Pro flag already handles it. When Pro IS active, treat the atomic-form
  // experiment as the caller's responsibility upstream (capabilities probe) but keep the structural
  // degrade available: if a rule needs an experiment and we cannot confirm it, fall back structurally.
  if (rule.requires?.experiment !== undefined && !ctx.pro_active) {
    return structuralBlock(containerTagFor(role, sourceTag));
  }

  // tabs: only map to e-tabs when menu/content counts match; else a structural block.
  if (role === 'tabs' && !ctx.tab_pairing_ok) {
    return structuralBlock(containerTagFor('structural-block', sourceTag));
  }

  return v4Result(rule, sourceTag);
}

/* ─────────────────────────── Tier-1 behavior targets (contract 16 §3) ───────────────────────── */

/*
 * The contract-16 §3 tier-1 table as target-builder data: when MAP detects a behavior pattern
 * (`IrNode.behaviors`) it RESTRUCTURES the subtree into these targets (map.ts owns the restructure
 * logic; these builders pin the exact element types + fallbacks so the §3 table lives here next to
 * the §6.2 role table). Validated live against the recon probes (.behavior-recon.json):
 * `e_tabs_working_tree` (scratch page 1669) for the e-tabs family and `classic_in_v4_verdict`
 * (scratch page 1665 — classic `nested-accordion` in a V4 document SAVES and RENDERS).
 */

/** The atomic e-tabs family members (recon `e_tabs_working_tree`: all five are CONTAINERS whose
 *  `elType` is the `e-*` type itself — NOT `elType:'widget'`). */
export type ETabsFamilyMember =
  | 'e-tabs'
  | 'e-tabs-menu'
  | 'e-tab'
  | 'e-tabs-content-area'
  | 'e-tab-content';

/**
 * Build the `MappingResult` for one e-tabs family member (contract 16 §3 row "tabs"). Structure
 * (recon-validated): `e-tabs > e-tabs-menu > e-tab*` + `e-tabs-content-area > e-tab-content*`;
 * tab labels are e-tab CHILD content (e-paragraph `tag:'span'`), `count(e-tab)` MUST equal
 * `count(e-tab-content)` (pairing is positional). V3 fallback: the whole family folds into the
 * classic `nested-tabs` widget at the root; inner members degrade to plain containers.
 */
export function eTabsFamilyTarget(member: ETabsFamilyMember): MappingResult {
  return {
    generation: 'v4',
    elType: member,
    is_container: true,
    settings_seed: {},
    v3_fallback:
      member === 'e-tabs'
        ? { elType: 'widget', widgetType: 'nested-tabs' }
        : { elType: 'container' },
  };
}

/** The classic nested-accordion widgetType (contract 16 §3 row "accordion", recon
 *  `classic_in_v4_verdict`: saves + renders inside a V4 document on the pinned 4.1.1 target). */
export const NESTED_ACCORDION_WIDGET = 'nested-accordion';

/**
 * Build the `MappingResult` for the classic `nested-accordion` widget emitted INSIDE a V4 document
 * (contract 16 §3: classic-in-v4, gated behind a per-run capability check in map.ts + the
 * orchestrator's post-save render check). The widget carries an `items` repeater
 * (`[{_id, item_title}]`) and one child classic `container` per item (upstream
 * `nested-accordion.php:item_content_container`). ASSEMBLE keeps the children (nested classic
 * widgets are NOT leaves).
 */
export function nestedAccordionTarget(): MappingResult {
  return {
    generation: 'v4',
    elType: 'widget',
    widgetType: NESTED_ACCORDION_WIDGET,
    is_container: false,
    settings_seed: {},
    v3_fallback: { elType: 'widget', widgetType: NESTED_ACCORDION_WIDGET },
  };
}

/**
 * Build the `MappingResult` for one nested-accordion item-content container (the classic `container`
 * child upstream pins per item: `{elType:'container', settings:{content_width:'full'}}`). The item's
 * converted content nodes become this container's children.
 */
export function accordionItemContainerTarget(): MappingResult {
  return {
    generation: 'v4',
    elType: 'container',
    is_container: true,
    settings_seed: {},
    v3_fallback: { elType: 'container' },
  };
}

/* ─────────────────────────── STYLE_WHITELIST (the PARSE getComputedStyle pick) ──────────────── */

/**
 * The exact `getComputedStyle` property names PARSE (WP-H03) captures and that can reach
 * `Style_Schema` (SUPPLEMENT §C.3 WHITELIST, `11-authoring-contract.md §5.2`). This is the contract
 * surface PARSE reads — keep it STABLE; additions require a versioned note (a re-freeze of WP-H01).
 * (Direction-awareness of physical↔logical mapping is owned by WP-H02, not here — these are the
 * PHYSICAL computed-style names the browser reports; WP-H02 maps margin-top → block-start, etc.)
 */
export const STYLE_WHITELIST: ReadonlyArray<string> = [
  // display / flexbox
  'display',
  'flex-direction',
  'flex-wrap',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'gap',
  'row-gap',
  'column-gap',
  'justify-content',
  'align-items',
  'align-self',
  'align-content',
  'justify-items',
  'order',
  // grid
  'grid-template-columns',
  'grid-template-rows',
  'grid-auto-flow',
  'grid-column',
  'grid-row',
  // sizing
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'aspect-ratio',
  'object-fit',
  'object-position',
  'overflow',
  // positioning
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'z-index',
  // spacing
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  // typography
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'color',
  'text-align',
  'text-decoration',
  'text-transform',
  'direction',
  // background
  'background-color',
  'background-image',
  'background-size',
  'background-position',
  'background-repeat',
  'background-attachment',
  'background-clip',
  // border
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  // effects
  'box-shadow',
  'opacity',
  'mix-blend-mode',
  'filter',
  'backdrop-filter',
  'transform',
  'transition',
  // outline / cursor
  'outline-width',
  'outline-style',
  'outline-color',
  'cursor',
];
