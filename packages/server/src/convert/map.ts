/**
 * WP-H06 — MAP stage (impl of `mapIr` + `seedSettingsForRole`, frozen seam `convert/types.ts`, WP-H01).
 *
 * The FOURTH HTML→native conversion stage (RESEARCH.md §6.1 step 4, §6.2 mapping table): turn each
 * classified IR node into a TARGET element-type decision — a V4 atomic element type + `tag` enum, the
 * V3 classic fallback, or a structural/html-widget last resort (the WHOLE-NODE fallback ladder,
 * authoring-contract §9). It calls the WP-H01 mapping table (`mapRole`/`containerTagFor`) with the live
 * capability context (`site.capabilities`) and produces a "mapped IR" annotated with the chosen
 * `target` (`MappingResult`) and the role-driven, NON-style `settings_seed`.
 *
 * It decides WHAT each node becomes; it does NOT wrap typed envelopes ({$$type,value} — WP-H08
 * ASSEMBLE), does NOT extract or attach styles (WP-H07 STYLE-EXTRACT), does NOT mint ids (WP-H08), and
 * does NO I/O. RAW values only in `settings_seed`; envelope wrapping is WP-H08 via `envelopes.ts`.
 *
 * Whole-node fallback ladder (authoring-contract §9, this WP) is DISTINCT from the per-DECLARATION
 * ladder owned by STYLE-EXTRACT (WP-H07). The `NodeFallback.tier` enum
 * (`native|v3_classic|structural_block|html_widget`) records the node-level decision; the orchestrator
 * (WP-H11) merges both ladders into the final coverage report — do not conflate the two enums.
 *
 * PURE module: deterministic given `(ir, ctx)`, idempotent, NO Playwright, NO `fs`, NO WP client.
 * Owns ONLY `mapIr`/`seedSettingsForRole` + helpers; `MapStageContext`/`MapResult`/`MappedNode`/
 * `NodeFallback`/`MappingResult`/`IrNode`/`SemanticRole`/`SiteCapabilities` are FROZEN in WP-H01
 * (`types.ts`) / WP-F05 and are imported, NEVER redeclared here.
 */

import {
  accordionItemContainerTarget,
  eTabsFamilyTarget,
  mapRole,
  NESTED_ACCORDION_WIDGET,
  nestedAccordionTarget,
} from './mapping-table.js';
import type { MapContext } from './mapping-table.js';
import type {
  AccentRule,
  BoxRect,
  ComputedStyleSet,
  DetectedBehavior,
  InlineFoldDrop,
  IrNode,
  MappedNode,
  MappingResult,
  MapResult,
  MapStageContext,
  NodeFallback,
  SemanticRole,
  SiteCapabilities,
  TextRun,
} from './types.js';

/* ─────────────────────────── settings-seed helpers (authoring-contract §4.1) ────────────────── */

/** The `e-heading` `tag` enum (`atomic-heading.php:48`). Source heading levels clamp into this set. */
const HEADING_TAG_ENUM: ReadonlySet<string> = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** The `e-paragraph` `tag` enum (`atomic-paragraph.php:50`, def `p`). */
const PARAGRAPH_TAG_ENUM: ReadonlySet<string> = new Set(['p', 'span']);

/**
 * The Pro atomic form-field input `type` enum (`e-form-input`, SUPPLEMENT §B.2) used when the source
 * `<input type=...>` lands on `e-form-input`. Out-of-enum kinds route to a dedicated atomic field type
 * (textarea/select/checkbox/radio) or clamp to `text`.
 */
const FORM_INPUT_TYPE_ENUM: ReadonlySet<string> = new Set([
  'text',
  'email',
  'number',
  'tel',
  'password',
]);

/**
 * Pick the `e-heading` `tag` from the source heading element's tag (`h1`..`h6`), clamped to the enum.
 * A non-`h*` source (rare — a div classified as a heading) defaults to `h2` (`atomic-heading.php` def).
 */
function headingTagFor(sourceTag: string): string {
  const lower = sourceTag.toLowerCase();
  return HEADING_TAG_ENUM.has(lower) ? lower : 'h2';
}

/** Pick the `e-paragraph` `tag` (`p`/`span`) from the source tag; non-enum → `p` (the prop default). */
function paragraphTagFor(sourceTag: string): string {
  const lower = sourceTag.toLowerCase();
  return PARAGRAPH_TAG_ENUM.has(lower) ? lower : 'p';
}

/**
 * The EXACT inline allowlist `wp_kses` keeps inside an `html-v3` value (`html-v3-prop-type.php:91`,
 * `11-authoring-contract.md §3.3`, mirrors `normalize.ts INLINE_ALLOWLIST`). When serializing a text
 * widget's runs back to inline markup, ONLY these tags are emitted; anything else (a disallowed inline
 * tag NORMALIZE recorded as stripped) collapses to bare text so the html-v3 content always survives
 * `wp_kses` byte-for-byte.
 */
const HTML_V3_INLINE_ALLOWLIST: ReadonlySet<string> = new Set([
  'b',
  'i',
  'em',
  'u',
  'a',
  'del',
  'span',
  'strong',
  'sup',
  'sub',
  's',
]);

/** Escape the text-node characters that would otherwise be parsed as markup in an html-v3 string. */
function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape a value for a double-quoted html-v3 attribute (`href`/`target`/`style`). */
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** The frozen inline-fold drop reasons (contract 17 I3) — exported so tests pin the exact wording. */
export const INLINE_FOLD_DROP_REASONS = {
  color_no_carrier:
    'inline run color differs from the parent text color but no allowlisted inline tag survives to scope a nested custom_css rule to — folded as bare text (contract 17 I3)',
  color_conflict:
    'inline run color conflicts with another run folded under the SAME inline tag — one nested custom_css rule per tag; the later color is dropped (contract 17 I3)',
} as const;

/**
 * Serialize a text widget's `textRuns` back into the `html-v3` `content` string, PRESERVING the inline
 * allowlist markup PARSE captured on each run (`inlineTags`). Each run's text is wrapped in its inline
 * tags inner→outer (e.g. a run `{text:'on autopilot', inlineTags:['span']}` → `<span>on autopilot</span>`);
 * disallowed tags are skipped (the text survives bare) so the result is always `wp_kses`-clean. This is
 * what folds an inline `<span>`/`<strong>` INSIDE a heading/paragraph/button into the parent's html-v3
 * `title`/`paragraph`/`text` instead of a separate child widget. Returns the trimmed inline markup; an
 * all-whitespace result yields `''` (the caller omits the prop).
 *
 * Contract 17 §5 additions (the inline-fold residuals — both `wp_kses`-safe per html-v3's allowlist):
 *  - **In-text links**: a run carrying `linkHref` serializes its INNERMOST `<a>` with
 *    `href` (+ `target` when captured) — `wp_kses` keeps `a[href][target]`, so the link stays live
 *    instead of folding to a dead bare `<a>`. A linked run whose `inlineTags` lost the `a` (defensive —
 *    PARSE always records it) gets an `<a href>` wrapper synthesized so the destination never drops.
 *  - **Accent colors (#8)**: a run whose `color` differs from the parent text node's computed color
 *    is recorded into `accents` keyed on its INNERMOST surviving tag — STYLE-EXTRACT materializes
 *    each as a nested custom_css rule (`& em{color:…}`) on the node's local style. An inline
 *    `style` attr is a DEAD END: `Html_Prop_Type::sanitize_value` runs `wp_kses` with a custom
 *    allowlist that strips every attribute except `a[href|target]` (live-verified — a saved
 *    `<em style>` came back bare). When NO allowlisted tag survives to scope a rule to (or two runs
 *    under the same tag want different colors), the loss is recorded in `drops` (`tier:'dropped'`,
 *    I3 — never silent); a color equal to the parent's is a no-op and is skipped without a record (I4).
 */
function nodeInlineHtml(
  node: IrNode,
  drops?: InlineFoldDrop[],
  accents?: AccentRule[],
): string {
  const parentColor = node.computed['color'];
  let html = '';
  for (const r of node.textRuns) {
    const tags = r.inlineTags
      .map((t) => t.toLowerCase())
      .filter((t) => HTML_V3_INLINE_ALLOWLIST.has(t));
    // Defensive: a linked run must serialize a live <a href> even if the `a` wrapper was lost.
    if (r.linkHref !== undefined && !tags.includes('a')) {
      tags.push('a');
    }
    const accent = r.color !== undefined && r.color !== parentColor ? r.color : undefined;
    if (accent !== undefined) {
      const host = tags.length > 0 ? (tags[tags.length - 1] as string) : undefined;
      const existing = host !== undefined ? accents?.find((a) => a.tag === host) : undefined;
      if (host !== undefined && accents !== undefined && existing === undefined) {
        accents.push({ tag: host, color: accent });
      } else if (existing !== undefined && existing.color === accent) {
        // Same tag, same color — already carried (two emerald <em>s in one heading).
      } else if (drops !== undefined) {
        drops.push({
          source_path: node.source_path,
          declaration: `color: ${accent}`,
          tier: 'dropped',
          reason:
            existing !== undefined
              ? INLINE_FOLD_DROP_REASONS.color_conflict
              : INLINE_FOLD_DROP_REASONS.color_no_carrier,
        });
      }
    }
    const linkIndex = r.linkHref !== undefined ? tags.lastIndexOf('a') : -1;
    let open = '';
    let close = '';
    for (let i = 0; i < tags.length; i += 1) {
      const tag = tags[i] as string;
      let attrs = '';
      if (i === linkIndex && r.linkHref !== undefined) {
        attrs += ` href="${escapeHtmlAttr(r.linkHref)}"`;
        if (r.linkTarget !== undefined) {
          attrs += ` target="${escapeHtmlAttr(r.linkTarget)}"`;
        }
      }
      open += `<${tag}${attrs}>`;
      close = `</${tag}>${close}`;
    }
    html += `${open}${escapeHtmlText(r.text)}${close}`;
  }
  return html.trim() === '' ? '' : html;
}

/**
 * Build the RAW `link` seed from the source `<a>` href + target (authoring-contract §3.1 `link`:
 * `{destination, isTargetBlank, tag:'a'}`). RAW values only — WP-H08 wraps `destination` as a `url`
 * envelope and the whole thing as a `link` envelope. Returns `undefined` when there is no href so the
 * seed key is omitted (an empty link would be dropped by PHP dry_run / is meaningless).
 */
function linkSeedFor(node: IrNode): Record<string, unknown> | undefined {
  const href = node.attrs['href'];
  if (href === undefined || href.trim() === '') {
    return undefined;
  }
  return {
    destination: href,
    isTargetBlank: node.attrs['target'] === '_blank',
    tag: 'a',
  };
}

/**
 * Resolve the concrete atomic form-field `widgetType` from the source field element (the §4 atomic
 * form-field family). `<textarea>` → `e-form-textarea`; `<select>` → `e-form-select`;
 * `<input type=checkbox>` → `e-form-checkbox`; `radio` → `e-form-radio-button`; `date`/`time`/`file` →
 * their pickers; everything else → `e-form-input` (with the input `type` clamped in `settings_seed`).
 * Used ONLY when the atomic-form path is active (MAP picks the kind; mapping-table pins the gating).
 */
function atomicFormFieldType(node: IrNode): string {
  const tag = node.tag.toLowerCase();
  if (tag === 'textarea') return 'e-form-textarea';
  if (tag === 'select') return 'e-form-select';
  const inputType = (node.attrs['type'] ?? 'text').toLowerCase();
  switch (inputType) {
    case 'checkbox':
      return 'e-form-checkbox';
    case 'radio':
      return 'e-form-radio-button';
    case 'date':
      return 'e-form-date-picker';
    case 'time':
      return 'e-form-time-picker';
    case 'file':
      return 'e-form-file-upload';
    case 'submit':
      // `<input type=submit>` is the form's submit control, not a data field (contract 16 §3).
      return 'e-form-submit-button';
    default:
      return 'e-form-input';
  }
}

/**
 * The e-form-submit-button target (contract 16 §3 "form → e-form family"): a `<button>` (whose
 * default type inside a form IS `submit`) or `<input type=submit>` inside an ACTIVE e-form maps to
 * the family's own submit widget instead of a generic `e-button` (recon: props `tag` + `text`,
 * `text` is html-v3).
 */
function submitButtonTarget(): MappingResult {
  return {
    generation: 'v4',
    elType: 'widget',
    widgetType: 'e-form-submit-button',
    is_container: false,
    settings_seed: {},
    v3_fallback: { elType: 'widget', widgetType: 'button' },
  };
}

/** True iff a button-ish node is a SUBMIT control (`<button>` defaults to type=submit in a form). */
function isSubmitControl(node: IrNode): boolean {
  const tag = node.tag.toLowerCase();
  const type = (node.attrs['type'] ?? (tag === 'button' ? 'submit' : '')).toLowerCase();
  return (tag === 'button' || tag === 'input') && type === 'submit';
}

/* ─────────────────────────── seedSettingsForRole (RAW, un-enveloped) ─────────────────────────── */

/**
 * Populate the role-driven RAW (un-enveloped) settings for a node given its resolved `target`
 * (authoring-contract §4.1). Returns ONLY role-driven, non-style settings with RAW values — NEVER a
 * typed envelope (WP-H08 wraps them via `envelopes.ts`). The keys are the AUTHORABLE prop NAMES from
 * §4.1 (`tag`, `title`, `paragraph`, `text`, `link`, `image`, `source`, …) so PHP `dry_run` accepts
 * them; a wrong name is silently dropped.
 *
 *  - `e-heading`            → `tag` (h1..h6 clamped) + `title` (raw text).
 *  - `e-paragraph`          → `tag` (p/span clamped) + `paragraph` (raw text).
 *  - `e-button`             → `text` (raw) + `link` ({destination,isTargetBlank,tag:'a'}).
 *  - `e-image`              → `image` placeholder marker `{__media_pending:<MediaRef>}` (ASSEMBLE
 *                             sideloads and fills the id-only `image-src`, §3.2) + `link` if wrapped.
 *  - `e-svg`                → `svg` placeholder marker `{__media_pending:<MediaRef>}` for sideload.
 *  - `e-youtube`            → `source` (raw embed url).
 *  - `e-self-hosted-video`  → `source` placeholder marker `{__media_pending:<MediaRef>}`.
 *  - containers (`e-div-block`/`e-flexbox`/`link`/`nav`/etc.) → `tag` (clamped enum) + `link` if `<a>`.
 *  - `e-form-*` fields      → `type` (input enum, clamped) when the concrete type is `e-form-input`.
 *
 * The `target` already carries a `settings_seed` (the mapping-table seeds the container `tag`); this
 * function returns the SUPERSET role-driven seed MAP attaches to the `MappedNode`.
 *
 * `inlineDrops` (optional — standalone callers may omit it) collects the contract-17 I3 inline-fold
 * losses `nodeInlineHtml` could not carry (accent colors with no inline tag to host a `style` attr);
 * `mapIr` threads its shared accumulator so every loss surfaces in `MapResult.inline_drops`.
 */
export function seedSettingsForRole(
  node: IrNode,
  target: MappingResult,
  inlineDrops?: InlineFoldDrop[],
  accents?: AccentRule[],
): Record<string, unknown> {
  // Start from the mapping-table's container `tag` seed (if any) so containers keep their clamped tag.
  const seed: Record<string, unknown> = { ...target.settings_seed };
  const widget = target.widgetType;

  // ── Widgets (atomic V4) ────────────────────────────────────────────────────────────────────
  if (widget === 'e-heading' || widget === 'heading') {
    seed['tag'] = headingTagFor(node.tag);
    // Serialize the heading's runs as inline html-v3 markup so a nested `<span>`/`<strong>`/inline `<a>`
    // folds into `title` instead of becoming a child widget (the load-bearing fix).
    const html = nodeInlineHtml(node, inlineDrops, accents);
    if (html !== '') seed['title'] = html;
    return seed;
  }

  if (widget === 'e-paragraph' || widget === 'text-editor') {
    seed['tag'] = paragraphTagFor(node.tag);
    const html = nodeInlineHtml(node, inlineDrops, accents);
    if (html !== '') seed['paragraph'] = html;
    // A plain text link (`<a>` with text, not button-like) maps here — keep its href so the text stays
    // clickable WITHOUT the e-button default chrome (e-paragraph has a `link` prop, atomic-paragraph.php).
    if (widget === 'e-paragraph') {
      const link = linkSeedFor(node);
      if (link !== undefined) seed['link'] = link;
    }
    return seed;
  }

  if (widget === 'e-button' || widget === 'button') {
    const html = nodeInlineHtml(node, inlineDrops, accents);
    if (html !== '') seed['text'] = html;
    const link = linkSeedFor(node);
    if (link !== undefined) seed['link'] = link;
    return seed;
  }

  if (widget === 'e-image' || widget === 'image') {
    // Placeholder marker — ASSEMBLE sideloads `node.media` and fills the id-only `image-src` (§3.2).
    if (node.media !== undefined) seed['image'] = { __media_pending: node.media };
    const link = linkSeedFor(node);
    if (link !== undefined) seed['link'] = link;
    return seed;
  }

  if (widget === 'e-svg' || widget === 'icon') {
    if (node.media !== undefined) seed['svg'] = { __media_pending: node.media };
    const link = linkSeedFor(node);
    if (link !== undefined) seed['link'] = link;
    return seed;
  }

  if (widget === 'e-youtube' || widget === 'video') {
    // YouTube embed url (raw string) → `source`. Self-hosted video carries a media marker instead.
    const url = node.media?.url;
    if (node.media?.kind === 'youtube' || widget === 'e-youtube') {
      if (url !== undefined && url !== '') seed['source'] = url;
    }
    return seed;
  }

  if (widget === 'e-self-hosted-video') {
    if (node.media !== undefined) seed['source'] = { __media_pending: node.media };
    return seed;
  }

  // ── Atomic form fields ──────────────────────────────────────────────────────────────────────
  if (widget === 'e-form-submit-button') {
    // `text` is an html-v3 prop (recon e-form-submit-button schema). A `<button>` carries runs; an
    // `<input type=submit>` carries its label in the `value` attr (escaped — it is raw attr text).
    const html = nodeInlineHtml(node, inlineDrops, accents);
    const value = node.attrs['value'];
    const label = html !== '' ? html : value !== undefined ? escapeHtmlText(value) : '';
    if (label !== '') seed['text'] = label;
    return seed;
  }

  if (widget !== undefined && widget.startsWith('e-form-')) {
    // The concrete atomic field type clamps the source input `type` into the e-form-input enum.
    if (widget === 'e-form-input') {
      const inputType = (node.attrs['type'] ?? 'text').toLowerCase();
      seed['type'] = FORM_INPUT_TYPE_ENUM.has(inputType) ? inputType : 'text';
    }
    const placeholder = node.attrs['placeholder'];
    if (placeholder !== undefined && placeholder !== '') seed['placeholder'] = placeholder;
    if (node.attrs['required'] !== undefined) seed['required'] = true;
    return seed;
  }

  // ── Containers (e-div-block / e-flexbox / e-tabs family / nav / list / table / accordion) ────
  // Ensure the container carries its clamped `tag` even when the mapping-table left it implicit
  // (e.g. a V3-fallback container has no tag). A wrapping <a> block also gets a `link` seed.
  if (target.is_container) {
    if (target.tag !== undefined && seed['tag'] === undefined) {
      seed['tag'] = target.tag;
    }
    const link = linkSeedFor(node);
    if (link !== undefined) seed['link'] = link;
    return seed;
  }

  return seed;
}

/* ─────────────────────────── MapContext construction + node mapping ──────────────────────────── */

/** Atomic-active = the site exposes atomic elements AND the requested generation is V4. */
function atomicActive(ctx: MapStageContext): boolean {
  return ctx.capabilities.atomic && ctx.generation === 'v4';
}

/**
 * Build the per-node WP-H01 `MapContext` from the stage context + the node's own signals. The atomic
 * form path additionally needs `e_pro_atomic_form`; `mapRole` only gates `requires.experiment` on
 * `pro_active`, so MAP pre-clears the atomic-form rule when the experiment is OFF by reporting
 * `pro_active:false` for form roles (so they degrade structurally) — see `mapNode`.
 */
function buildMapContext(node: IrNode, ctx: MapStageContext): MapContext {
  const proForRole =
    (node.role === 'form' || node.role === 'form-field') && !ctx.capabilities.pro_atomic_form
      ? false
      : ctx.capabilities.pro;
  return {
    pro_active: proForRole,
    atomic_active: atomicActive(ctx),
    child_count: node.children.length,
    has_youtube: node.media?.kind === 'youtube',
    tab_pairing_ok: ctx.tab_pairing[node.source_path] ?? false,
  };
}

/**
 * Contract 18 §7 P2-d — carry the SOURCE element id onto the converted node so in-page anchors
 * (`<a href="#pricing">` → `<section id="pricing">`) keep their targets (the hrefs were already
 * carried by the §5 link folds; without the ids every one of them scrolled nowhere). The mechanism
 * that actually RENDERS on an atomic target is the universal `_cssid` prop: `has-atomic-base.php`
 * auto-adds it to EVERY atomic element's props schema (`String_Prop_Type`) and the base twig
 * macros / PHP renderers emit `id="{{ settings._cssid }}"` — the `attributes` transformer is a
 * render no-op, so seeding raw attributes would silently drop. On a CLASSIC (V3/html-widget)
 * target the renderable equivalent is the standard `_element_id` setting. ASSEMBLE already wraps
 * a raw string seed generically (`string` envelope on atomic; raw value on classic), so MAP only
 * seeds the right key. Never overwrites an existing seed; whitespace-only ids are meaningless.
 */
function seedSourceId(
  node: IrNode,
  target: MappingResult,
  seed: Record<string, unknown>,
): Record<string, unknown> {
  const sourceId = node.attrs['id'];
  if (sourceId === undefined || sourceId.trim() === '') {
    return seed;
  }
  const atomicTarget =
    target.widgetType?.startsWith('e-') === true || target.elType.startsWith('e-');
  const key = atomicTarget ? '_cssid' : '_element_id';
  if (seed[key] === undefined) {
    seed[key] = sourceId.trim();
  }
  return seed;
}

/** Whole-node fallback ladder tier (authoring-contract §9) for a resolved target + ctx. */
function fallbackTierFor(target: MappingResult, ctx: MapStageContext): NodeFallback['tier'] {
  // The `html` widget dump is the LOWEST rung of the ladder regardless of generation (e.g. a <table>
  // with no atomic equivalent that degraded to the V3 `html` widget last resort).
  if (target.widgetType === 'html') {
    return 'html_widget';
  }
  // Atomic inactive → the whole tree mapped to a V3 classic widget/container.
  if (!atomicActive(ctx)) {
    return 'v3_classic';
  }
  // Roles with NO atomic equivalent (list/table/accordion) + Pro/experiment-gated roles that degraded
  // to a generic e-div-block are the structural-block approximation tier.
  return 'structural_block';
}

/**
 * Human-readable fallback reason for the report. Distinguishes the generation fallback (atomic OFF)
 * from the role-specific degrades (no atomic equivalent / Pro absent / experiment off / unpaired tabs).
 */
function fallbackReason(node: IrNode, ctx: MapStageContext): string {
  if (!atomicActive(ctx)) {
    return ctx.generation === 'v4'
      ? 'atomic elements inactive on this site — whole tree mapped to V3 classic'
      : 'generation v3 requested — mapped to V3 classic';
  }
  switch (node.role) {
    case 'list':
      return 'no atomic list widget — mapped to e-div-block + e-paragraph items';
    case 'table':
      return 'no atomic table widget — mapped to e-div-block grid approximation / html widget';
    case 'accordion':
    case 'accordion-item':
      return 'no atomic accordion in 4.1.x — mapped to styled e-div-block approximation';
    case 'tabs':
      return 'tab/content counts do not match — mapped to a structural e-div-block';
    case 'nav-menu':
      return 'Pro inactive — mapped to e-div-block + e-button list (no bound nav-menu widget)';
    case 'form':
    case 'form-field':
      return ctx.capabilities.pro
        ? 'e_pro_atomic_form experiment inactive — mapped to a structural form approximation (enable e_pro_atomic_form for native e-form)'
        : 'Pro inactive — mapped to a structural form approximation';
    default:
      return 'no native atomic target — mapped to a structural e-div-block approximation';
  }
}

/**
 * Was the node mapped to its NATIVE atomic/V3 target, or did it land on a fallback tier? A native
 * mapping is recorded with `tier:'native'` ONLY when no degrade happened (so the report can compute
 * honest coverage). The degrade signals are: atomic inactive (whole-tree V3), a NO_ATOMIC_EQUIVALENT
 * role, a Pro/experiment-gated role without the capability, or unpaired tabs.
 */
function isFallback(node: IrNode, ctx: MapStageContext): boolean {
  if (!atomicActive(ctx)) {
    return true;
  }
  const caps = ctx.capabilities;
  switch (node.role) {
    case 'list':
    case 'table':
    case 'accordion':
    case 'accordion-item':
      return true;
    case 'tabs':
      return !(ctx.tab_pairing[node.source_path] ?? false);
    case 'nav-menu':
      return !caps.pro;
    case 'form':
    case 'form-field':
      return !(caps.pro && caps.pro_atomic_form);
    default:
      return false;
  }
}

/* ─────────────────────────── behavior tiering + tier-1 restructures (contract 16 §3) ─────────── */

/*
 * Contract 16 §1: `DetectedBehavior.tier`/`reason` are ASSIGNED BY MAPPING (detection leaves them
 * unset). This section owns the tier-1 native-widget rows of the §3 table (tabs/form/video/accordion)
 * plus the honest tier-4 drops (carousel/nav-toggle and every tier-1 degrade). Tier-2 kinds
 * (entrance-animation/hover-effect — `behavior-interactions.ts`) and tier-3 (`custom-js` passthrough)
 * belong to OTHER stages: MAP passes their behaviors through UNTAGGED. Tagging never mutates the
 * input IR — `MappedNode.behaviors` carries NEW objects (`{...b, tier, reason}`), keeping `mapIr`
 * pure and idempotent (and the §8 invariant-5 zero-behavior byte-identity trivially intact).
 */

/** The frozen tier-reason strings the behavior report surfaces (exported so tests + the coverage
 *  stage pin the exact wording — "never a silent lie", contract 16 §0.2). */
export const BEHAVIOR_TIER_REASONS = {
  tabs_native:
    'native e-tabs family — tab labels from triggers, panels recursively converted; the static subtree is replaced',
  tabs_unpaired:
    'tab triggers/panels not identifiable or counts mismatch — left as static structure (no e-tabs emitted)',
  tabs_atomic_inactive:
    'atomic elements inactive — the e-tabs family is unavailable; left as static structure',
  accordion_native:
    'classic nested-accordion in a V4 document (classic-in-v4 save+render verified; post-save render check applies)',
  accordion_unextractable:
    'accordion items not structurally extractable (no details/summary or aria-expanded trigger+panel pairs) — degraded to stacked sections, toggle behavior dropped',
  accordion_not_registered:
    'nested-accordion is not registered on this site — degraded to stacked sections, toggle behavior dropped',
  accordion_atomic_inactive:
    'atomic elements inactive — accordion maps to the V3 classic fallback; behavior conversion is not verified there',
  form_native:
    'native e-form family — input types mapped; submit actions are NOT converted (e-form defaults to the email action)',
  form_unavailable:
    'Pro atomic form unavailable (requires Pro + e_pro_atomic_form) — static approximation only, the form does not submit',
  video_youtube: 'routed to the native e-youtube widget',
  video_self_hosted: 'routed to the native e-self-hosted-video widget',
  video_v3: 'routed to the classic V3 video widget (atomic inactive)',
  carousel_dropped: 'no atomic carousel in v1 — slides emit as a static layout fallback',
  nav_toggle_dropped:
    'nav toggle is not converted in v1 — menu links convert statically, the toggle behavior is dropped',
  marquee_dropped:
    'no native marquee widget — content emits as a static block, the scrolling behavior is dropped',
  countdown_dropped:
    'no native countdown widget — content emits statically, the ticking behavior is dropped',
  host_replaced: 'host element was replaced by a tier-1 subtree conversion',
  superseded: 'superseded by another pattern conversion rooted on the same node',
} as const;

/**
 * Per-run capability check for the classic-in-v4 `nested-accordion` path (contract 16 §3). The
 * authoritative gate is `capabilities.registered_types.classic`; an EMPTY list means the probe could
 * not enumerate types (the registered_types probe is known to return empty lists on current plugin
 * builds) and we fall back to the recon verdict (`.behavior-recon.json classic_in_v4_verdict`:
 * classic nested-accordion SAVES and RENDERS inside a V4 document on the pinned 4.1.1 target). A
 * POPULATED list without the widget is a hard "not available" → tier-4 stacked-sections degrade.
 */
function classicNestedAccordionAvailable(caps: SiteCapabilities): boolean {
  const classic = caps.registered_types.classic;
  return classic.length === 0 || classic.includes(NESTED_ACCORDION_WIDGET);
}

const ZERO_BOX: BoxRect = { x: 0, y: 0, width: 0, height: 0 };

/** Build a synthetic IrNode for a structure-only family member (e-tabs-menu / e-tabs-content-area /
 *  accordion item container / tab label). `donor` lends ONLY its visual fields (box/computed/
 *  responsive/hover/focus) so STYLE-EXTRACT preserves the source styling — never attrs/runs/behaviors. */
function syntheticNode(
  source_path: string,
  tag: string,
  role: SemanticRole,
  donor?: IrNode,
): IrNode {
  return {
    source_path,
    tag,
    role,
    box: donor?.box ?? ZERO_BOX,
    computed: donor?.computed ?? {},
    responsive: donor?.responsive ?? {},
    attrs: {},
    textRuns: [],
    children: [],
    ...(donor?.hoverComputed !== undefined ? { hoverComputed: donor.hoverComputed } : {}),
    ...(donor?.focusComputed !== undefined ? { focusComputed: donor.focusComputed } : {}),
  };
}

/** Visibility props a behavior-widget RUNTIME owns (tabs panels: Alpine x-show inline display). */
const RUNTIME_VISIBILITY_PROPS = ['display', 'visibility'] as const;

/**
 * Copy of `node` without runtime-owned visibility props (base + responsive + state overrides) —
 * for tier-1 family members whose show/hide the NATIVE widget controls (e-tab-content): the
 * parse-time snapshot only renders the ACTIVE panel, so a captured `display:none`/`visibility:
 * hidden` is transient UI state, not authored styling. Never mutates the input IR.
 */
function stripRuntimeVisibility(node: IrNode): IrNode {
  const strip = <T extends Partial<ComputedStyleSet>>(set: T): T =>
    Object.fromEntries(
      Object.entries(set).filter(
        ([prop]) => !(RUNTIME_VISIBILITY_PROPS as readonly string[]).includes(prop),
      ),
    ) as T;
  return {
    ...node,
    computed: strip(node.computed),
    responsive: Object.fromEntries(
      Object.entries(node.responsive).map(([bp, set]) => [bp, strip(set)]),
    ),
    ...(node.hoverComputed !== undefined ? { hoverComputed: strip(node.hoverComputed) } : {}),
    ...(node.focusComputed !== undefined ? { focusComputed: strip(node.focusComputed) } : {}),
  };
}

/** Depth-first visit of `node` and every descendant (local pure helper). */
function walkIr(node: IrNode, fn: (n: IrNode) => void): void {
  fn(node);
  for (const c of node.children) walkIr(c, fn);
}

/** Every `source_path` in the subtree rooted at `node` (self included). */
function subtreePaths(node: IrNode): string[] {
  const out: string[] = [];
  walkIr(node, (n) => out.push(n.source_path));
  return out;
}

/** All text runs in a subtree, document order (labels/titles aggregate nested inline markup). */
function subtreeRuns(node: IrNode): TextRun[] {
  const runs: TextRun[] = [];
  walkIr(node, (n) => runs.push(...n.textRuns));
  return runs;
}

/** Plain subtree text (runs concatenated, whitespace collapsed) — repeater titles are plain strings. */
function subtreeText(node: IrNode): string {
  return subtreeRuns(node)
    .map((r) => r.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Deterministic 7-hex token (FNV-1a) for repeater `_id`s — these are SETTINGS values, not element
 *  ids (element ids are minted by ASSEMBLE, §8.1); stable so `mapIr` stays deterministic. */
function hex7(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(0, 7);
}

/**
 * Assign tier+reason to ONE behavior on the NORMAL (non-restructured) mapping path. Owns the §3 rows
 * that need no restructure: `form` (the role mapping itself lands on the e-form family),
 * `video-embed` (already routed to e-youtube / e-self-hosted-video — surfaced through the behavior
 * report per §3), and the honest tier-4 drops `carousel`/`nav-toggle`. A `tabs`/`accordion` behavior
 * reaching here on a RESTRUCTURED root means a second pattern claimed the same node → tier 4
 * (superseded); on the normal path those kinds are pre-resolved by the caller. Tier-2/3 kinds pass
 * through untagged (their stages own them). Never mutates `b`.
 */
function assignBehaviorTier(
  b: DetectedBehavior,
  node: IrNode,
  ctx: MapStageContext,
  warnings: string[],
  onRestructuredRoot: boolean,
): DetectedBehavior {
  switch (b.kind) {
    case 'form': {
      const native = atomicActive(ctx) && ctx.capabilities.pro && ctx.capabilities.pro_atomic_form;
      if (!native) {
        return { ...b, tier: 4, reason: BEHAVIOR_TIER_REASONS.form_unavailable };
      }
      const action = node.attrs['action'];
      if (action !== undefined && action.trim() !== '') {
        warnings.push(
          `${node.source_path}: form action "${action}" is NOT converted — e-form submit actions default to the email action (configure actions-after-submit on the site)`,
        );
      }
      return { ...b, tier: 1, reason: BEHAVIOR_TIER_REASONS.form_native };
    }
    case 'video-embed': {
      const reason = !atomicActive(ctx)
        ? BEHAVIOR_TIER_REASONS.video_v3
        : node.role === 'media-embed-youtube' || node.media?.kind === 'youtube'
          ? BEHAVIOR_TIER_REASONS.video_youtube
          : BEHAVIOR_TIER_REASONS.video_self_hosted;
      return { ...b, tier: 1, reason };
    }
    case 'carousel':
      return { ...b, tier: 4, reason: BEHAVIOR_TIER_REASONS.carousel_dropped };
    case 'nav-toggle':
      return { ...b, tier: 4, reason: BEHAVIOR_TIER_REASONS.nav_toggle_dropped };
    case 'marquee':
      // No native target on any tier — MAP (the tier-1/4 owner) records the honest drop so every
      // detected behavior leaves the pipeline tiered (§8 invariant 1).
      return { ...b, tier: 4, reason: BEHAVIOR_TIER_REASONS.marquee_dropped };
    case 'countdown':
      return { ...b, tier: 4, reason: BEHAVIOR_TIER_REASONS.countdown_dropped };
    case 'tabs':
    case 'accordion':
      return onRestructuredRoot ? { ...b, tier: 4, reason: BEHAVIOR_TIER_REASONS.superseded } : b;
    default:
      // entrance-animation / hover-effect (the tier-2 interactions stage) and custom-js (the tier-3
      // JS-passthrough decision) are OTHER stages' kinds; MAP passes them through untouched.
      return b;
  }
}

/**
 * Audit a REPLACED pattern subtree ("never a silent lie", §0.2): warn for any dropped node that
 * carried text/media, and ORPHAN-tag (tier 4) behaviors whose host node no longer exists in the
 * mapped output. `kept` = source_paths that survive (as family members or recursively-converted
 * content); the pattern root itself survives as the tier-1 widget. `contentConsumed` = paths whose
 * text was CONSUMED elsewhere (e.g. trigger descendants collapsing into a synthetic tab label) —
 * no content warning for those (the text is not lost), but their behaviors are still orphans: the
 * host node itself is gone from the mapped tree (§8 invariant 1 — every behavior stays reported).
 */
function auditReplacedSubtree(
  root: IrNode,
  kept: ReadonlySet<string>,
  label: string,
  warnings: string[],
  contentConsumed: ReadonlySet<string> = new Set<string>(),
): DetectedBehavior[] {
  const orphans: DetectedBehavior[] = [];
  walkIr(root, (n) => {
    if (n.source_path === root.source_path || kept.has(n.source_path)) return;
    if (
      !contentConsumed.has(n.source_path) &&
      (n.textRuns.some((r) => r.text.trim() !== '') || n.media !== undefined)
    ) {
      warnings.push(`${n.source_path}: content dropped by the ${label} subtree replacement`);
    }
    for (const ob of n.behaviors ?? []) {
      orphans.push({ ...ob, tier: 4, reason: BEHAVIOR_TIER_REASONS.host_replaced });
    }
  });
  return orphans;
}

/** Tag the pattern-root behaviors after a tier-1 restructure: the converted behavior gets tier 1;
 *  every OTHER behavior on the same node goes through the normal tagger; orphans are appended. */
function restructuredBehaviors(
  node: IrNode,
  converted: DetectedBehavior,
  tier1Reason: string,
  orphans: DetectedBehavior[],
  ctx: MapStageContext,
  warnings: string[],
): DetectedBehavior[] {
  const tagged = (node.behaviors ?? []).map((b) =>
    b === converted
      ? { ...b, tier: 1 as const, reason: tier1Reason }
      : assignBehaviorTier(b, node, ctx, warnings, true),
  );
  return [...tagged, ...orphans];
}

/**
 * Tier the behaviors of a SURVIVING family-member host (trigger/panel/tablist) of a tier-1
 * restructure, as a spreadable `{behaviors}` patch. The member's `{...node}` spread would otherwise
 * carry CLASSIFY's RAW untiered objects into the mapped tree: a MAP-owned kind sitting on the
 * member itself (e.g. a `carousel` on a tab panel) would then reach the coverage assembler untiered
 * and HARD-fail invariant §8.1 — here it gets its honest tier instead. Tier-2/3 kinds pass through
 * untagged on purpose: the member node survives in the mapped tree (source_path preserved), so the
 * interactions / JS-passthrough stages can still resolve and tier them. Never mutates the input IR.
 */
function memberBehaviors(
  node: IrNode,
  ctx: MapStageContext,
  warnings: string[],
): { behaviors?: DetectedBehavior[] } {
  if (node.behaviors === undefined) return {};
  return {
    behaviors: node.behaviors.map((b) => assignBehaviorTier(b, node, ctx, warnings, true)),
  };
}

/**
 * Tier-1 TABS restructure (contract 16 §3 row "tabs", recon `e_tabs_working_tree`): rebuild the
 * detected pattern subtree as the canonical atomic family
 *
 *   e-tabs > e-tabs-menu > e-tab* (label = e-paragraph tag:'span' from the trigger's text)
 *          > e-tabs-content-area > e-tab-content* (panel children recursively converted)
 *
 * REPLACING the static subtree (§3 rule / §8 invariant 4 — no duplicate static copy). The trigger
 * node hosts its e-tab (source_path + computed styles preserved); the panel node hosts its
 * e-tab-content; the tablist node hosts the e-tabs-menu; wrappers between them are absorbed
 * (audited — dropped text/media warns, orphaned behaviors are tier-4 tagged). `default-active-tab`
 * (0-based) comes from `aria-selected`. Returns `null` when triggers/panels are not identifiable or
 * counts mismatch (recon rule: `count(e-tab)` MUST equal `count(e-tab-content)`) — the caller tags
 * the behavior tier 4 and falls through to the normal static mapping.
 */
function restructureTabs(
  node: IrNode,
  behavior: DetectedBehavior,
  ctx: MapStageContext,
  fallbacks: NodeFallback[],
  warnings: string[],
  inlineDrops: InlineFoldDrop[],
): MappedNode | null {
  const triggers: IrNode[] = [];
  const panels: IrNode[] = [];
  let tablist: IrNode | undefined;
  walkIr(node, (n) => {
    if (n.role === 'tab') triggers.push(n);
    else if (n.role === 'tab-content') panels.push(n);
    else if (n.role === 'tabs' && tablist === undefined) tablist = n;
  });
  if (triggers.length === 0 || triggers.length !== panels.length) {
    return null;
  }

  const rootIsTablist = tablist !== undefined && tablist.source_path === node.source_path;

  // ── e-tab per trigger: the trigger hosts the e-tab; its label is an e-paragraph (tag:'span'). ──
  const tabNodes: MappedNode[] = triggers.map((trigger) => {
    const labelIr = syntheticNode(`${trigger.source_path}::label`, 'span', 'text');
    labelIr.textRuns = subtreeRuns(trigger);
    const label = mapNode(labelIr, ctx, fallbacks, warnings, inlineDrops);
    walkIr(trigger, (n) => {
      if (n.source_path !== trigger.source_path && n.media !== undefined) {
        warnings.push(
          `${n.source_path}: tab trigger media dropped — e-tab labels are text-only in v1`,
        );
      }
    });
    return {
      ...trigger,
      ...memberBehaviors(trigger, ctx, warnings),
      target: eTabsFamilyTarget('e-tab'),
      settings_seed: {},
      children: [label],
    };
  });

  // ── e-tab-content per panel: the panel hosts it; panel children convert NORMALLY (§3 rule —
  //    text/style fidelity preserved through the regular node conversion). A LEAF panel carries its
  //    copy on its OWN runs (childless div → no child node to convert): synthesize a text child for
  //    them or the e-tab-content ships empty and the panel copy silently drops (§3 rule / §0.2).
  //    Panel VISIBILITY is runtime-owned (Alpine x-show toggles INLINE display over the widget's
  //    `display:block` base — atomic-tab-content.php): at parse time only the active panel renders,
  //    so persisting an inactive panel's `display:none` would lock it closed forever — strip it. ──
  const contentNodes: MappedNode[] = panels.map((panel) => {
    const children = panel.children.map((c) => mapNode(c, ctx, fallbacks, warnings, inlineDrops));
    if (panel.textRuns.length > 0) {
      const textIr = syntheticNode(`${panel.source_path}::text`, 'p', 'text');
      textIr.textRuns = panel.textRuns;
      children.unshift(mapNode(textIr, ctx, fallbacks, warnings, inlineDrops));
    }
    return {
      ...stripRuntimeVisibility(panel),
      ...memberBehaviors(panel, ctx, warnings),
      target: eTabsFamilyTarget('e-tab-content'),
      settings_seed: {},
      children,
    };
  });

  // ── e-tabs-menu: hosted by the tablist (styles preserved); synthetic when the root IS the
  //    tablist (the tablist styles then live on the menu, not the e-tabs root). ──
  const menuIr =
    tablist !== undefined && !rootIsTablist
      ? tablist
      : syntheticNode(
          `${node.source_path}::e-tabs-menu`,
          'div',
          'structural-block',
          rootIsTablist ? node : undefined,
        );
  const menu: MappedNode = {
    ...syntheticNode(menuIr.source_path, menuIr.tag, 'structural-block', menuIr),
    // The surviving tablist's behaviors ride its e-tabs-menu (the synthetic base never carries
    // behaviors); when the root IS the tablist they live on the e-tabs root instead
    // (`restructuredBehaviors` below) — never duplicated here.
    ...(tablist !== undefined && !rootIsTablist ? memberBehaviors(tablist, ctx, warnings) : {}),
    target: eTabsFamilyTarget('e-tabs-menu'),
    settings_seed: {},
    children: tabNodes,
  };

  const area: MappedNode = {
    ...syntheticNode(`${node.source_path}::e-tabs-content-area`, 'div', 'structural-block'),
    target: eTabsFamilyTarget('e-tabs-content-area'),
    settings_seed: {},
    children: contentNodes,
  };

  // ── default-active-tab (0-based) from aria-selected; default 0. ──
  const selected = triggers.findIndex(
    (t) => (t.attrs['aria-selected'] ?? '').toLowerCase() === 'true',
  );
  const activeTab = selected >= 0 ? selected : 0;

  // ── replaced-subtree audit: panel subtrees + the trigger/tablist HOST nodes survive (each hosts
  //    its family member); trigger DESCENDANTS do not — only the synthetic label child materializes,
  //    so their text counts as consumed (it IS the label; media was warned above) but any behavior
  //    they carry is orphan-tagged (the host is gone from the mapped tree — §8.1, never silent). ──
  const kept = new Set<string>();
  if (tablist !== undefined) kept.add(tablist.source_path);
  const labelConsumed = new Set<string>();
  for (const t of triggers) {
    kept.add(t.source_path);
    for (const p of subtreePaths(t)) if (p !== t.source_path) labelConsumed.add(p);
  }
  for (const pn of panels) for (const p of subtreePaths(pn)) kept.add(p);
  const orphans = auditReplacedSubtree(node, kept, 'e-tabs', warnings, labelConsumed);

  // When the root IS the tablist its visual styles moved onto the e-tabs-menu — strip them from
  // the e-tabs root so the tab-row layout is not applied twice (synthetic base = empty visual
  // fields; identity/attrs/runs restored from the node).
  let rootIr: IrNode = node;
  if (rootIsTablist) {
    rootIr = {
      ...syntheticNode(node.source_path, node.tag, node.role),
      box: node.box,
      attrs: node.attrs,
      textRuns: node.textRuns,
      children: node.children,
    };
  }

  return {
    ...rootIr,
    target: eTabsFamilyTarget('e-tabs'),
    // P2-d — a pattern root keeps its in-page anchor target too (`<div id="faq">` tabs).
    settings_seed: seedSourceId(node, eTabsFamilyTarget('e-tabs'), {
      'default-active-tab': activeTab,
    }),
    behaviors: restructuredBehaviors(
      node,
      behavior,
      BEHAVIOR_TIER_REASONS.tabs_native,
      orphans,
      ctx,
      warnings,
    ),
    children: [menu, area],
  };
}

/** One extracted accordion item: plain-text title + the content nodes + the consumed title subtree. */
interface AccordionItem {
  title: string;
  contentNodes: IrNode[];
  titlePaths: string[];
}

/**
 * Extract accordion items from the pattern root: `<details>` (summary = title, rest = content — one
 * item per details element) or `aria-expanded` trigger + following-sibling panel pairs (multi-item).
 * Returns `null` when no item is structurally extractable — classname-only accordions degrade to
 * tier 4 (guessing item boundaries from styling alone would be a silent lie).
 */
function extractAccordionItems(node: IrNode): AccordionItem[] | null {
  if (node.tag.toLowerCase() === 'details') {
    const summary = node.children.find((c) => c.tag.toLowerCase() === 'summary');
    if (summary === undefined) return null;
    const content = node.children.filter((c) => c !== summary);
    if (content.length === 0) return null;
    return [
      { title: subtreeText(summary), contentNodes: content, titlePaths: subtreePaths(summary) },
    ];
  }
  const items: AccordionItem[] = [];
  let i = 0;
  while (i < node.children.length) {
    const trigger = node.children[i] as IrNode;
    const panel = node.children[i + 1];
    if (trigger.attrs['aria-expanded'] !== undefined && panel !== undefined) {
      items.push({
        title: subtreeText(trigger),
        contentNodes: [panel],
        titlePaths: subtreePaths(trigger),
      });
      i += 2;
    } else {
      i += 1;
    }
  }
  return items.length > 0 ? items : null;
}

/**
 * Tier-1 ACCORDION restructure (contract 16 §3 row "accordion", per the recon verdict
 * `classic_in_v4_verdict`: classic `nested-accordion` SAVES and RENDERS inside a V4 document):
 * rebuild the pattern as the classic widget — `items` repeater (`[{_id, item_title}]`, titles from
 * the summary/trigger text) + one classic `container` child per item holding the item's recursively
 * converted content (upstream `nested-accordion.php` child shape). The caller gates on
 * `classicNestedAccordionAvailable` (the per-run capability check) and atomic generation; the
 * orchestrator owns the §3 post-save render check. Records the node on the `v3_classic` whole-node
 * ladder tier (it IS a classic widget inside a V4 document — honest coverage). Returns `null` when
 * items are not structurally extractable.
 */
function restructureAccordion(
  node: IrNode,
  behavior: DetectedBehavior,
  ctx: MapStageContext,
  fallbacks: NodeFallback[],
  warnings: string[],
  inlineDrops: InlineFoldDrop[],
): MappedNode | null {
  const items = extractAccordionItems(node);
  if (items === null) {
    return null;
  }

  const itemContainers: MappedNode[] = items.map((item, idx) => ({
    ...syntheticNode(
      `${node.source_path}::accordion-item-${String(idx + 1)}`,
      'div',
      'structural-block',
    ),
    target: accordionItemContainerTarget(),
    // Upstream pins `content_width:'full'` on each item container (nested-accordion.php:66-77).
    settings_seed: { content_width: 'full' },
    children: item.contentNodes.map((c) => mapNode(c, ctx, fallbacks, warnings, inlineDrops)),
  }));

  const repeater = items.map((item, idx) => ({
    _id: hex7(`${node.source_path}::accordion-item-${String(idx)}`),
    item_title: item.title !== '' ? item.title : `Item #${String(idx + 1)}`,
  }));

  // ── replaced-subtree audit: content subtrees survive; title subtrees collapse to repeater
  //    strings (their text IS consumed — only media + behaviors are lost); the rest is absorbed. ──
  const kept = new Set<string>();
  for (const item of items) {
    for (const c of item.contentNodes) for (const p of subtreePaths(c)) kept.add(p);
  }
  const titlePathSet = new Set<string>(items.flatMap((it) => it.titlePaths));
  const orphans: DetectedBehavior[] = [];
  walkIr(node, (n) => {
    if (n.source_path === node.source_path || kept.has(n.source_path)) return;
    if (titlePathSet.has(n.source_path)) {
      if (n.media !== undefined) {
        warnings.push(
          `${n.source_path}: accordion title media dropped — nested-accordion titles are text-only`,
        );
      }
    } else if (n.textRuns.some((r) => r.text.trim() !== '') || n.media !== undefined) {
      warnings.push(
        `${n.source_path}: content dropped by the nested-accordion subtree replacement`,
      );
    }
    for (const ob of n.behaviors ?? []) {
      orphans.push({ ...ob, tier: 4, reason: BEHAVIOR_TIER_REASONS.host_replaced });
    }
  });

  // Whole-node ladder: a classic widget inside a V4 document is the v3_classic tier (the BEHAVIOR
  // is tier 1; the NODE is not a native atomic element — both are reported, honestly).
  fallbacks.push({
    source_path: node.source_path,
    tier: 'v3_classic',
    reason:
      'accordion → classic nested-accordion inside the V4 document (interactive; recon-verified classic-in-v4 render)',
  });

  return {
    ...node,
    target: nestedAccordionTarget(),
    // P2-d — the accordion root keeps its in-page anchor target (classic path → `_element_id`).
    settings_seed: seedSourceId(node, nestedAccordionTarget(), { items: repeater }),
    behaviors: restructuredBehaviors(
      node,
      behavior,
      BEHAVIOR_TIER_REASONS.accordion_native,
      orphans,
      ctx,
      warnings,
    ),
    children: itemContainers,
  };
}

/**
 * Map ONE node (and recurse into children), pushing fallbacks/warnings into the shared accumulators.
 * Resolves the target via `mapRole`, then for atomic form-fields swaps in the concrete `e-form-*`
 * `widgetType` MAP picks from the source element kind (the mapping-table pins only the gating + the
 * default `e-form-input`).
 *
 * Contract 16 §3: a node carrying a `tabs`/`accordion` `DetectedBehavior` is first offered to the
 * tier-1 restructures (which REPLACE the whole pattern subtree); on success the restructured family
 * is returned and the normal role mapping never runs for the consumed nodes (§8 invariant 4 — no
 * duplicate static copy). Every behavior kind this stage owns leaves MAP tier-tagged (new objects —
 * the input IR is never mutated). `inAtomicForm` threads the active-e-form context so submit
 * controls land on `e-form-submit-button`.
 */
function mapNode(
  node: IrNode,
  ctx: MapStageContext,
  fallbacks: NodeFallback[],
  warnings: string[],
  inlineDrops: InlineFoldDrop[],
  inAtomicForm = false,
): MappedNode {
  // ── <canvas> carry — a canvas is a SCRIPT-DRAWN surface: mapping it to a div renders a dead box
  // AND breaks the carried first-party script that calls getContext on it (field-found: the shader
  // bundle threw `canvas.getContext is not a function` on every resync). Emit a REAL <canvas> via
  // the html widget (lowest ladder rung), preserving class/id/aria so the carried JS re-binds.
  if (node.tag === 'canvas') {
    const attrs = ['class', 'id', 'aria-hidden', 'aria-label', 'role', 'width', 'height']
      .map((k) => {
        const v = node.attrs[k];
        return v !== undefined && v !== '' ? ` ${k}="${escapeHtmlAttr(v)}"` : '';
      })
      .join('');
    return {
      ...node,
      target: {
        generation: 'v4' as const,
        elType: 'widget',
        widgetType: 'html',
        is_container: false,
        settings_seed: {},
        v3_fallback: { elType: 'widget', widgetType: 'html' },
      },
      settings_seed: { html: `<canvas${attrs}></canvas>` },
      children: [],
    };
  }

  // ── Tier-1 behavior restructures (contract 16 §3) — the pattern root replaces its subtree. ──
  const tier4Pending = new Map<DetectedBehavior, string>();

  const tabsBehavior = node.behaviors?.find((b) => b.kind === 'tabs');
  if (tabsBehavior !== undefined) {
    if (!atomicActive(ctx)) {
      tier4Pending.set(tabsBehavior, BEHAVIOR_TIER_REASONS.tabs_atomic_inactive);
    } else {
      const restructured = restructureTabs(
        node,
        tabsBehavior,
        ctx,
        fallbacks,
        warnings,
        inlineDrops,
      );
      if (restructured !== null) {
        return restructured;
      }
      tier4Pending.set(tabsBehavior, BEHAVIOR_TIER_REASONS.tabs_unpaired);
      warnings.push(
        `${node.source_path}: tabs behavior detected but triggers/panels are not identifiable or counts mismatch — left as static structure`,
      );
    }
  }

  const accordionBehavior = node.behaviors?.find((b) => b.kind === 'accordion');
  if (accordionBehavior !== undefined) {
    if (!atomicActive(ctx)) {
      tier4Pending.set(accordionBehavior, BEHAVIOR_TIER_REASONS.accordion_atomic_inactive);
    } else if (!classicNestedAccordionAvailable(ctx.capabilities)) {
      tier4Pending.set(accordionBehavior, BEHAVIOR_TIER_REASONS.accordion_not_registered);
    } else {
      const restructured = restructureAccordion(
        node,
        accordionBehavior,
        ctx,
        fallbacks,
        warnings,
        inlineDrops,
      );
      if (restructured !== null) {
        return restructured;
      }
      tier4Pending.set(accordionBehavior, BEHAVIOR_TIER_REASONS.accordion_unextractable);
    }
  }

  const mapCtx = buildMapContext(node, ctx);
  let target = mapRole(node.role, mapCtx, node.tag);

  const atomicFormPath =
    atomicActive(ctx) && ctx.capabilities.pro && ctx.capabilities.pro_atomic_form;

  // When the atomic form path IS active, pick the concrete atomic field type for a form-field.
  if (node.role === 'form-field' && atomicFormPath && target.widgetType === 'e-form-input') {
    const concrete = atomicFormFieldType(node);
    if (concrete !== 'e-form-input') {
      target = { ...target, widgetType: concrete };
    }
  }

  // A submit `<button>` inside an ACTIVE e-form maps to the family's own e-form-submit-button
  // (an `<input type=submit>` form-field already resolved via `atomicFormFieldType` above).
  if (inAtomicForm && atomicFormPath && node.role === 'button' && isSubmitControl(node)) {
    target = submitButtonTarget();
  }

  // Record the whole-node fallback tier when the node did NOT land on its native target.
  if (isFallback(node, ctx)) {
    fallbacks.push({
      source_path: node.source_path,
      tier: fallbackTierFor(target, ctx),
      reason: fallbackReason(node, ctx),
    });
  }

  // Surface agent-actionable hints for capability-gated degrades that are user-fixable.
  if (atomicActive(ctx)) {
    if (
      (node.role === 'form' || node.role === 'form-field') &&
      ctx.capabilities.pro &&
      !ctx.capabilities.pro_atomic_form
    ) {
      warnings.push(
        `${node.source_path}: native atomic form requires the e_pro_atomic_form experiment — enable it for an e-form, otherwise this is a structural approximation`,
      );
    }
    if (node.role === 'tabs' && !(ctx.tab_pairing[node.source_path] ?? false)) {
      warnings.push(
        `${node.source_path}: tab menu and content counts do not match — mapped to a structural block instead of e-tabs`,
      );
    }
  }

  // Contract 17 #8 — collect the inline accents the html-v3 fold cannot carry as attributes
  // (the sanitizer strips them); STYLE-EXTRACT materializes them as nested custom_css rules.
  const accentRules: AccentRule[] = [];
  const settings_seed = seedSourceId(
    node,
    target,
    seedSettingsForRole(node, target, inlineDrops, accentRules),
  );
  const childInForm = inAtomicForm || (atomicFormPath && target.elType === 'e-form');
  const children = node.children.map((child) =>
    mapNode(child, ctx, fallbacks, warnings, inlineDrops, childInForm),
  );

  const mapped: MappedNode = {
    ...node,
    target,
    settings_seed,
    children,
    ...(accentRules.length > 0 ? { accent_rules: accentRules } : {}),
  };

  // ── Behavior tiering (contract 16 §1: tier/reason are assigned by MAPPING; the input IR is
  //    never mutated — the MappedNode carries NEW behavior objects). ──
  if (node.behaviors !== undefined) {
    mapped.behaviors = node.behaviors.map((b) => {
      const pendingReason = tier4Pending.get(b);
      if (pendingReason !== undefined) {
        return { ...b, tier: 4 as const, reason: pendingReason };
      }
      return assignBehaviorTier(b, node, ctx, warnings, false);
    });
  }

  return mapped;
}

/* ─────────────────────────── mapIr (the stage entrypoint) ────────────────────────────────────── */

/**
 * MAP stage entrypoint (RESEARCH.md §6.2). Resolve every classified IR node to its Elementor target
 * (V4 atomic / V3 classic / structural / html-widget last resort, the §9 whole-node ladder) and the
 * role-driven RAW `settings_seed`. Pure & deterministic given `(ir, ctx)`; never throws — every role
 * has a documented degrade in `mapRole`.
 *
 * Behaviour summary (authoring-contract §4/§9):
 *  - generation `v4` + atomic ON  → atomic targets (`e-*`); atomic OFF → whole tree → V3 classic.
 *  - `list`/`table`/`accordion`   → structural `e-div-block` approximations (or `html` for table) — a
 *    recorded `NodeFallback`, never `native`.
 *  - paired tabs → the full `e-tabs` family; unpaired tabs → structural block + fallback.
 *  - `form`/`form-field` → `e-form`/`e-form-*` ONLY with Pro + `e_pro_atomic_form`; else structural.
 *  - `nav-menu` → Pro bound widget ONLY with Pro; else `e-div-block` + `e-button` list.
 *
 * Contract 16 §3 (behavior conversion): detected `tabs` restructure into the canonical atomic
 * `e-tabs` family and detected `accordion`s into the classic `nested-accordion` (capability-gated),
 * each REPLACING its static subtree; `form`/`video-embed` route through their existing native
 * targets; `carousel`/`nav-toggle` are honest tier-4 drops. Every behavior kind MAP owns leaves with
 * `tier`+`reason` set (`collectDetectedBehaviors` gathers them for the §6 behavior report).
 *
 * Contract 17 I3 (total accounting): every inline-fold side effect the html-v3 serialization could
 * not carry (accent colors with no inline tag to host a `style` attr) is recorded in
 * `MapResult.inline_drops` (`tier:'dropped'`) — never a silent loss.
 */
export function mapIr(ir: IrNode[], ctx: MapStageContext): MapResult {
  const fallbacks: NodeFallback[] = [];
  const warnings: string[] = [];
  const inline_drops: InlineFoldDrop[] = [];
  const nodes = ir.map((n) => mapNode(n, ctx, fallbacks, warnings, inline_drops));
  return { nodes, fallbacks, warnings, inline_drops };
}

/**
 * Gather every `DetectedBehavior` carried by a mapped forest, document order (contract 16 §6 — the
 * behavior report reads the MAPPED tree, whose behavior objects carry the tier/reason MAP assigned;
 * the pre-map IR's objects deliberately stay untiered/unmutated).
 */
export function collectDetectedBehaviors(nodes: MappedNode[]): DetectedBehavior[] {
  const out: DetectedBehavior[] = [];
  const walk = (n: MappedNode): void => {
    out.push(...(n.behaviors ?? []));
    for (const c of n.children) walk(c);
  };
  for (const n of nodes) walk(n);
  return out;
}

/* ─────────────────────────── re-exports for downstream stages ────────────────────────────────── */

/** Re-export the role vocabulary so consumers importing MAP do not need a second import. */
export type { SemanticRole };
