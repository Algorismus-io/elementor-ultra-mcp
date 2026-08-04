/**
 * WP-H08 — ASSEMBLE stage (impl of `assembleTree`, frozen seam `convert/types.ts`, WP-H01).
 *
 * The SIXTH HTML→native conversion stage (RESEARCH.md §6.1 step 6, SUPPLEMENT §C.4): turn the
 * styled, mapped IR (`StyledNode[]`) into a concrete `ElementNode[]` authoring tree — the FIRST place
 * the pipeline becomes WP-F03 authoring nodes carrying typed envelopes. ASSEMBLE:
 *
 *   1. mints a unique 7-hex element id per node (WP-F03 `ids.ts`, deduped against `ctx.existing_ids`
 *      and within the tree; optionally cross-checked via `IdPort.validate`) — authoring-contract §8.1;
 *   2. finalizes each node's local styles to `e-<elementId>-<7hex>` ids, writes them into `styles`,
 *      and MIRRORS each into `settings.classes.value` (the §5.1 HARD rule — a styles-map id absent from
 *      `classes` silently detaches; a TS pre-check flags `LOCAL_STYLE_UNLINKED`);
 *   3. sideloads every `<img>`/background image via the injected `MediaPort` and emits the `image`/
 *      `image-src` ID-ONLY (id-XOR-url, authoring-contract §3.2 HARD; url-only only for true externals);
 *   4. wraps every `settings_seed` value and style prop value in its typed envelope via WP-F03
 *      `envelopes.ts` (`classes` is a BARE string array; UNION members single-wrap; `html-v3` uses the
 *      `{content,children}` shape) — authoring-contract §3.
 *
 * It does NOT hoist global classes / create variables (WP-H09), does NOT persist (WP-H11 / the PHP save
 * route), and does NOT prime CSS (orchestrator). It produces a complete, dry-run-ready tree with only
 * LOCAL styles + sideloaded media. The only WP dependency is behind the injected `MediaPort`/`IdPort`
 * ports (no direct WP-client import) so the stage is unit-testable without a live site.
 *
 * Ordering (so the placeholder local-style ids WP-H07 emits finalize consistently): mint element ids
 * FIRST (depth-first, document order), then build the styles map + mirror into `classes`, then sideload
 * + image-src, then wrap envelopes.
 *
 * `assembleTree`/`AssembleContext`/`AssembleResult`/`SideloadError`/`MediaPort`/`IdPort`/`StyledNode`
 * are FROZEN in WP-H01 (`types.ts`); this WP IMPLEMENTS the function and `import type`s them — it does
 * NOT redeclare them. `ElementNode`/`StyleDefinition`/typed envelopes are WP-F03 shared types.
 */

import { createHash } from 'node:crypto';

import {
  CLASS_NAME_PATTERN,
  classesValue,
  htmlV3,
  imageSrcById,
  imageSrcByUrl,
  isClassesValue,
  isValidImageSrc,
  typedValue,
} from '../authoring/envelopes.js';
import { mintLocalStyleId, mintUniqueId } from '../authoring/ids.js';
import type {
  AtomicContainerNode,
  AtomicContainerType,
  AtomicWidgetNode,
  AtomicWidgetType,
  Classes,
  ClassicNode,
  ElementNode,
  Image,
  ImageSrc,
  Link,
  StyleDefinition,
  StyleVariant,
  TypedValue,
} from '../authoring/contract.js';
import type { MediaRef } from './types.js';
import type {
  AssembleContext,
  AssembleResult,
  MappingResult,
  SideloadError,
  StyledNode,
} from './types.js';

/* ─────────────────────────── settings-seed → typed-envelope wrapping ─────────────────────────── */

/**
 * The MAP-stage placeholder marker for media that ASSEMBLE must sideload (`map.ts seedSettingsForRole`):
 * `image`/`svg`/`source` seeds carry `{__media_pending:<MediaRef>}`. ASSEMBLE replaces it with the
 * sideloaded id-only envelope (or a url-only/placeholder fallback).
 */
interface MediaPendingMarker {
  __media_pending: MediaRef;
}

/** True iff a `settings_seed` value is a MAP-stage `{__media_pending}` marker. */
function isMediaPending(value: unknown): value is MediaPendingMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    '__media_pending' in value &&
    typeof (value as { __media_pending?: unknown }).__media_pending === 'object'
  );
}

/** The RAW `link` seed shape MAP emits (`{destination,isTargetBlank,tag}`, authoring-contract §3.1). */
interface LinkSeed {
  destination?: string;
  isTargetBlank?: boolean;
  tag?: string;
}

/** True iff a `settings_seed` value is the RAW `link` seed (a record with a string `destination`). */
function isLinkSeed(value: unknown): value is LinkSeed {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { destination?: unknown }).destination === 'string'
  );
}

/**
 * Build a `link` typed value from the RAW MAP seed (authoring-contract §3.1 `link`):
 * `{$$type:'link', value:{destination:<url envelope>, isTargetBlank:<bool>, tag:{$$type:'string',value:'a'}}}`.
 * `destination` is the chosen UNION member's own envelope (a `url` envelope — never double-wrapped).
 */
function buildLink(seed: LinkSeed): Link {
  const value: {
    destination?: TypedValue;
    isTargetBlank?: TypedValue;
    tag?: TypedValue;
  } = {
    tag: typedValue('string', seed.tag ?? 'a'),
  };
  if (typeof seed.destination === 'string' && seed.destination !== '') {
    value.destination = typedValue('url', seed.destination);
  }
  // `isTargetBlank` is a NESTED Boolean_Prop_Type on the Link object (`link-prop-type.php`): the PHP
  // atomic validator rejects a BARE boolean (`link: invalid_value`) — it must be wrapped as a
  // `{$$type:'boolean', value:<bool>}` envelope like every other nested prop value. (Verified against
  // `documents/0/dry-run`: bare boolean → invalid; boolean envelope → valid.)
  value.isTargetBlank = typedValue('boolean', seed.isTargetBlank === true);
  return { $$type: 'link', value };
}

/**
 * The atomic prop names whose RAW seed value is plain text that becomes an `html-v3` envelope
 * (authoring-contract §4.1: `title`/`paragraph`/`text` carry the `{content,children}` form). Other text
 * settings (e.g. a container `tag`) wrap as a plain `string` envelope instead.
 */
const HTML_V3_TEXT_PROPS: ReadonlySet<string> = new Set(['title', 'paragraph', 'text']);

/**
 * Wrap a single RAW `settings_seed` entry into its typed envelope (authoring-contract §3). Returns
 * `undefined` to OMIT a key (an empty/meaningless value PHP `dry_run` would drop). Media markers are
 * resolved by the caller (they need async sideload) — this synchronous wrapper skips them.
 */
function wrapSettingValue(prop: string, raw: unknown): TypedValue | undefined {
  // `link` — build the union/object envelope from the raw seed.
  if (prop === 'link') {
    if (isLinkSeed(raw)) {
      return buildLink(raw);
    }
    return undefined;
  }

  // text props → html-v3 `{content,children}`; the rest of the string seeds → plain `string`.
  if (typeof raw === 'string') {
    if (raw === '') {
      return undefined;
    }
    if (HTML_V3_TEXT_PROPS.has(prop)) {
      return htmlV3(raw);
    }
    return typedValue('string', raw);
  }

  if (typeof raw === 'number') {
    return typedValue('number', raw);
  }
  if (typeof raw === 'boolean') {
    return typedValue('boolean', raw);
  }

  // string-array seeds (e.g. `actions-after-submit`) wrap each item as a `string` envelope.
  if (Array.isArray(raw)) {
    const items = raw
      .filter((item): item is string => typeof item === 'string')
      .map((item) => typedValue('string', item));
    return { $$type: 'string-array', value: items };
  }

  return undefined;
}

/* ─────────────────────────── image / media → id-XOR-url image-src ────────────────────────────── */

/** Build an `image` envelope wrapping an `image-src` (size defaults to the `'full'` string envelope). */
function buildImage(src: ImageSrc): Image {
  return {
    $$type: 'image',
    value: { src, size: typedValue('string', 'full') },
  };
}

/** Build an id-only `image-src` (preferred; after sideload, authoring-contract §3.2). */
function imageSrcId(attachmentId: number, alt?: string): ImageSrc {
  const altEnvelope = alt !== undefined && alt !== '' ? typedValue('string', alt) : undefined;
  return imageSrcById(typedValue('image-attachment-id', attachmentId), altEnvelope);
}

/** Build a url-only `image-src` (true externals only — sideload disabled or failed). */
function imageSrcUrl(url: string, alt?: string): ImageSrc {
  const altEnvelope = alt !== undefined && alt !== '' ? typedValue('string', alt) : undefined;
  return imageSrcByUrl(typedValue('url', url), altEnvelope);
}

/* ─────────────────────────── per-run sideload cache (no double sideload) ─────────────────────── */

/**
 * Caches sideload outcomes WITHIN one conversion run so the same source url is never sideloaded twice
 * (RESEARCH.md §5.5; cross-document dedupe is the plugin's source-hash job). Keyed by source url.
 */
class SideloadCache {
  private readonly hits = new Map<string, number>();

  has(url: string): boolean {
    return this.hits.has(url);
  }

  get(url: string): number | undefined {
    return this.hits.get(url);
  }

  set(url: string, attachmentId: number): void {
    this.hits.set(url, attachmentId);
  }
}

/* ─────────────────────────── ASSEMBLE pass state ─────────────────────────────────────────────── */

/** Mutable accumulators threaded through the (async) assembly walk. */
interface AssembleState {
  ctx: AssembleContext;
  /** The live used-id set (seeded from `existing_ids`); every mint adds to it. */
  usedIds: Set<string>;
  cache: SideloadCache;
  mediaMap: Record<string, number>;
  sideloadErrors: SideloadError[];
  mintedIds: string[];
  localStyleIds: string[];
}

/* ─────────────────────────── source-class preservation (opt-in) ──────────────────────────────── */

/** Source prefixes that would collide with the atomic system's own class namespaces. */
const SYSTEM_CLASS_PREFIX = /^(e-|g-|elementor)/;

/** Per-element cap — semantic hooks, not a wholesale class dump (Tailwind-y sources can carry 30+). */
const MAX_SOURCE_CLASSES = 8;

/**
 * Sanitize a source `class` attribute into the tokens worth preserving as enhancement anchors:
 * contract-valid class names only (`CLASS_NAME_PATTERN`, R7 — the same rule `isClassesValue`
 * enforces on the whole envelope), system prefixes skipped, deduped, capped. Order preserved (the
 * FIRST classes on an element are usually its semantic identity — `rk-band`, `hh-hero`).
 */
function sourceClassNames(classAttr: string | undefined): string[] {
  if (classAttr === undefined || classAttr.trim() === '') {
    return [];
  }
  const out: string[] = [];
  for (const token of classAttr.split(/\s+/)) {
    if (token === '' || !CLASS_NAME_PATTERN.test(token) || SYSTEM_CLASS_PREFIX.test(token)) {
      continue;
    }
    if (!out.includes(token)) {
      out.push(token);
    }
    if (out.length >= MAX_SOURCE_CLASSES) {
      break;
    }
  }
  return out;
}

/* ─────────────────────────── style-map finalization + §5.1 mirroring ─────────────────────────── */

/**
 * Finalize a node's local styles against its now-minted element id: re-key each placeholder
 * `StyleDefinition` to `e-<elementId>-<7hex>`, build the `styles` map, and return the list of finalized
 * ids (the caller mirrors them into `settings.classes` — the §5.1 HARD rule). Mints each id uniquely
 * against the live id set so two nodes never share a local-style id.
 */
function finalizeLocalStyles(
  elementId: string,
  localStyles: StyleDefinition[],
  state: AssembleState,
): { stylesMap: Record<string, StyleDefinition>; ids: string[] } {
  const stylesMap: Record<string, StyleDefinition> = {};
  const ids: string[] = [];
  for (const def of localStyles) {
    const id = mintLocalStyleId(elementId);
    const variants: StyleVariant[] = def.variants.map((v) => ({ ...v }));
    stylesMap[id] = { id, type: 'class', label: def.label, variants };
    ids.push(id);
    state.localStyleIds.push(id);
  }
  return { stylesMap, ids };
}

/* ─────────────────────────── background-image → style overlay (§3.2) ─────────────────────────── */

/**
 * Build a `background` typed value with a single image-overlay whose image src is id-only (preferred;
 * authoring-contract §3.2 / SUPPLEMENT §B.1 `background`/`background-image-overlay`). Used when the
 * source carries a CSS background image that sideloaded successfully.
 */
/** The non-fill background riders the overlay shape accepts (native `Background_Image_Overlay`). */
interface BackgroundOverlayRiders {
  size?: 'auto' | 'cover' | 'contain';
  repeat?: 'repeat' | 'repeat-x' | 'repeat-y' | 'no-repeat';
  /** A `Position_Prop_Type` enum string (`center center`, …). */
  position?: string;
}

/** Mine the overlay riders from the node's computed background longhands (enum-valid only). */
function backgroundOverlayRiders(computed: Record<string, string>): BackgroundOverlayRiders {
  const riders: BackgroundOverlayRiders = {};
  const size = computed['background-size'];
  if (size === 'cover' || size === 'contain' || size === 'auto') riders.size = size;
  const repeat = computed['background-repeat'];
  if (
    repeat === 'repeat' ||
    repeat === 'repeat-x' ||
    repeat === 'repeat-y' ||
    repeat === 'no-repeat'
  ) {
    riders.repeat = repeat;
  }
  const position = computed['background-position'];
  if (position !== undefined && /^(left|center|right) (top|center|bottom)$/.test(position)) {
    riders.position = position;
  } else if (position === '50% 50%') {
    riders.position = 'center center';
  }
  return riders;
}

function buildBackgroundOverlay(src: ImageSrc, riders: BackgroundOverlayRiders = {}): TypedValue {
  const imageOverlay: TypedValue = {
    $$type: 'background-image-overlay',
    value: {
      image: buildImage(src),
      // Riders ride the overlay item itself (native shape) — without them the widget default
      // TILED the photo at natural size (W18 band 12: zoomed seam instead of one cover photo).
      ...(riders.size !== undefined ? { size: { $$type: 'string', value: riders.size } } : {}),
      ...(riders.repeat !== undefined
        ? { repeat: { $$type: 'string', value: riders.repeat } }
        : {}),
      ...(riders.position !== undefined
        ? { position: { $$type: 'string', value: riders.position } }
        : {}),
    },
  };
  return {
    $$type: 'background',
    value: {
      'background-overlay': { $$type: 'background-overlay', value: [imageOverlay] },
    },
  };
}

/**
 * Inject the sideloaded `background` image-overlay into the node's base (desktop, normal) style variant,
 * creating a local style if the node has none. Mirrors the new style id into `classes` via the caller's
 * style finalization. Returns the (possibly new) style id list to mirror; `null` if no style was added.
 */
function applyBackgroundOverlay(
  src: ImageSrc,
  elementId: string,
  stylesMap: Record<string, StyleDefinition>,
  state: AssembleState,
  riders: BackgroundOverlayRiders = {},
): string | null {
  const overlay = buildBackgroundOverlay(src, riders);
  // Prefer an existing base variant on the FIRST local style; else create a fresh local style.
  const firstId = Object.keys(stylesMap)[0];
  if (firstId !== undefined) {
    const def = stylesMap[firstId];
    if (def !== undefined) {
      const base = def.variants.find(
        (v) => v.meta.breakpoint === 'desktop' && v.meta.state === null,
      );
      if (base !== undefined) {
        base.props = { ...base.props, background: overlay };
      } else {
        def.variants = [
          ...def.variants,
          { meta: { breakpoint: 'desktop', state: null }, props: { background: overlay } },
        ];
      }
      return null;
    }
  }
  const newId = mintLocalStyleId(elementId);
  stylesMap[newId] = {
    id: newId,
    type: 'class',
    label: 'local',
    variants: [{ meta: { breakpoint: 'desktop', state: null }, props: { background: overlay } }],
  };
  state.localStyleIds.push(newId);
  return newId;
}

/* ─────────────────────────── media sideload (async, cached) ──────────────────────────────────── */

/**
 * Resolve a media reference to an `image-src`: sideload the url (when `sideload_media`) and emit
 * id-only; on a disabled toggle OR a sideload failure, degrade to url-only (recording a non-fatal
 * `SideloadError`). Returns `null` only when there is no usable url at all (neither id nor url — the
 * caller then omits the prop rather than emit an XOR-violating envelope).
 */
async function resolveImageSrc(
  media: MediaRef,
  sourcePath: string,
  state: AssembleState,
): Promise<ImageSrc | null> {
  const url = media.url;
  if (url === undefined || url === '') {
    return null;
  }
  // Inline `<svg>` markup on an IMAGE-prop widget (an image-classified inline `<svg>` — e.g. a
  // 60×44 logo mark too large for the icon role): the "url" is the element's outerHTML, not a URL.
  // Upload it as a standalone .svg (same dedupe/xmlns handling as resolveSvgSrc) and emit id-only —
  // routing it into the URL leg emitted markup as the `url` and PHP rejected `image: invalid_value`.
  if (media.kind === 'svg' && url.trimStart().startsWith('<')) {
    if (state.cache.has(url)) {
      const cachedId = state.cache.get(url);
      return cachedId !== undefined ? imageSrcId(cachedId, media.alt) : null;
    }
    try {
      const markup = /<svg[^>]*\sxmlns=/.test(url)
        ? url
        : url.replace(/<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
      const filename = `inline-${createHash('sha1').update(url).digest('hex').slice(0, 10)}.svg`;
      const result = await state.ctx.media.upload(new TextEncoder().encode(markup), filename);
      state.cache.set(url, result.id);
      state.mediaMap[filename] = result.id;
      return imageSrcId(result.id, media.alt);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      state.sideloadErrors.push({ source_path: sourcePath, url: url.slice(0, 120), reason });
      return null; // markup can never be a url-only fallback — omit the prop honestly
    }
  }
  if (!state.ctx.sideload_media) {
    // Sideload disabled → keep the true external (url-only).
    return imageSrcUrl(url, media.alt);
  }
  // Cache within the run so the same url is never sideloaded twice.
  if (state.cache.has(url)) {
    const cachedId = state.cache.get(url);
    return cachedId !== undefined ? imageSrcId(cachedId, media.alt) : imageSrcUrl(url, media.alt);
  }
  try {
    const result = await state.ctx.media.sideloadUrl(url, media.alt);
    state.cache.set(url, result.id);
    state.mediaMap[url] = result.id;
    return imageSrcId(result.id, media.alt);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    state.sideloadErrors.push({ source_path: sourcePath, url, reason });
    // Non-fatal: degrade to url-only so the node still renders (id-XOR-url stays valid).
    return imageSrcUrl(url, media.alt);
  }
}

/* ─────────────────────────── inline <svg> / svg url → `svg-src` envelope ─────────────────────── */

/** Build an id-only `svg-src` envelope (e-svg `Svg_Src_Prop_Type`: `{id,url}`, ≥1 non-null key). */
function svgSrcById(attachmentId: number): TypedValue {
  return {
    $$type: 'svg-src',
    value: { id: typedValue('image-attachment-id', attachmentId), url: null },
  };
}

/** Build a url-only `svg-src` envelope (true external `.svg` only — sideload disabled or failed). */
function svgSrcByUrl(url: string): TypedValue {
  return { $$type: 'svg-src', value: { id: null, url: typedValue('url', url) } };
}

/**
 * Resolve an e-svg media ref into an `svg-src` envelope. Inline `<svg>` markup (PARSE stores the
 * element's outerHTML in `url` when `kind === 'svg'`) is uploaded as a sanitized `.svg` attachment via
 * `MediaPort.upload` — the sideload route cannot fetch markup, and raw markup must NEVER be emitted as
 * a url. A real URL (e.g. `<img src="x.svg">` classified as an icon) goes through the normal sideload
 * path but is wrapped as `svg-src` (e-svg rejects `image` envelopes). Returns `null` (prop omitted →
 * the widget's default svg) when inline markup cannot be uploaded.
 */
async function resolveSvgSrc(
  media: MediaRef,
  sourcePath: string,
  state: AssembleState,
): Promise<TypedValue | null> {
  const ref = media.url;
  if (ref === undefined || ref === '') {
    return null;
  }
  if (media.kind !== 'svg') {
    // Real URL (icon-classified <img src="….svg">) — reuse the image sideload cache semantics.
    if (!state.ctx.sideload_media) {
      return svgSrcByUrl(ref);
    }
    if (state.cache.has(ref)) {
      const cachedId = state.cache.get(ref);
      return cachedId !== undefined ? svgSrcById(cachedId) : svgSrcByUrl(ref);
    }
    try {
      const result = await state.ctx.media.sideloadUrl(ref, media.alt);
      state.cache.set(ref, result.id);
      state.mediaMap[ref] = result.id;
      return svgSrcById(result.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      state.sideloadErrors.push({ source_path: sourcePath, url: ref, reason });
      return svgSrcByUrl(ref);
    }
  }
  // Inline `<svg>` markup — dedupe within the run by the markup string itself.
  if (state.cache.has(ref)) {
    const cachedId = state.cache.get(ref);
    return cachedId !== undefined ? svgSrcById(cachedId) : null;
  }
  try {
    // Browser outerHTML omits xmlns on inline SVG; a standalone .svg file needs it to render.
    const markup = /<svg[^>]*\sxmlns=/.test(ref)
      ? ref
      : ref.replace(/<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    const filename = `inline-${createHash('sha1').update(ref).digest('hex').slice(0, 10)}.svg`;
    const result = await state.ctx.media.upload(new TextEncoder().encode(markup), filename);
    state.cache.set(ref, result.id);
    state.mediaMap[filename] = result.id;
    return svgSrcById(result.id);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    state.sideloadErrors.push({ source_path: sourcePath, url: '(inline svg)', reason });
    return null;
  }
}

/* ─────────────────────────── node assembly (async, document order) ───────────────────────────── */

/** The atomic container element-type set (matches `AtomicContainerType`). */
const ATOMIC_CONTAINER_TYPES: ReadonlySet<string> = new Set<AtomicContainerType>([
  'e-div-block',
  'e-flexbox',
  'e-tabs',
  'e-tabs-menu',
  'e-tab',
  'e-tabs-content-area',
  'e-tab-content',
  'e-form',
  'e-form-success-message',
  'e-form-error-message',
]);

/** Is the resolved target an atomic node (V4) we should build as an atomic container/widget? */
function isAtomicTarget(target: MappingResult): boolean {
  if (typeof target.widgetType === 'string' && target.widgetType.startsWith('e-')) {
    return true;
  }
  return ATOMIC_CONTAINER_TYPES.has(target.elType);
}

/**
 * Atomic CHILD-BEARING widget types — the ONLY atomic widgets whose template renders inner elements
 * (`e-tab-content` can serialize as a widget and hosts its panel content, authoring-contract §4).
 * EVERY other atomic widget is a LEAF: the text widgets (e-heading/e-paragraph/e-button — content
 * rides inline as `html-v3`, a child element makes the frontend choke, ticket req 2b), and the
 * media/field widgets (e-image, e-svg, e-youtube, e-divider, the e-form-* fields). A leaf widget
 * MUST be emitted with an EMPTY `elements[]`: children nested under one never render, and on save
 * the PHP side strips their `styles` maps while their `settings.classes` mirrors SURVIVE — exactly
 * the page-1704 corruption (the SVG-wrapper path emitted e-div-blocks inside e-svg widgets: 12
 * dangling `e-<id>-<7hex>` class refs with no style definition → zero-size icons + deterministic
 * CSS_PRIME_FAILED). ASSEMBLE drops any children that reach a leaf widget (NORMALIZE folds inline
 * children in; this is the defensive backstop) and prunes their minted local-style ids so the
 * reference closure holds (contract 17 I1).
 */
const CHILD_BEARING_ATOMIC_WIDGETS: ReadonlySet<string> = new Set<AtomicWidgetType>([
  'e-tab-content',
]);

/**
 * Reconcile the pass state after a subtree is DROPPED (children of a leaf atomic widget, the
 * e-paragraph degenerate-widget fallback, or a flat classic widget): remove the dropped nodes'
 * finalized local-style ids from `state.localStyleIds` so `AssembleResult.local_style_ids` only ever
 * reports styles that are actually IN the emitted tree. Without this, every drop leaks orphan ids
 * into the result (the closure pattern behind the page-1704 dangling refs, contract 17 I1).
 * Minted ELEMENT ids are intentionally kept: `minted_ids` pairs positionally with the mapped
 * pre-order in the orchestrator's `buildSourcePathIdMap`, so removing entries would shift every
 * subsequent source_path → id pairing.
 */
function pruneDroppedSubtreeStyles(dropped: ElementNode[], state: AssembleState): void {
  const droppedStyleIds = new Set<string>();
  const walk = (nodes: ElementNode[]): void => {
    for (const node of nodes) {
      const styles = (node as { styles?: Record<string, StyleDefinition> }).styles;
      if (styles !== undefined) {
        for (const id of Object.keys(styles)) {
          droppedStyleIds.add(id);
        }
      }
      if (Array.isArray(node.elements) && node.elements.length > 0) {
        walk(node.elements);
      }
    }
  };
  walk(dropped);
  if (droppedStyleIds.size > 0) {
    state.localStyleIds = state.localStyleIds.filter((id) => !droppedStyleIds.has(id));
  }
}

/**
 * Build the SETTINGS map for an atomic node: wrap every role-driven RAW `settings_seed` value into its
 * typed envelope, resolve the media markers (sideload → id-only `image`), and ALWAYS include a
 * `classes` envelope (default empty; the §5.1 mirror appends local-style ids). Async because media
 * resolution is async.
 */
async function buildAtomicSettings(
  node: StyledNode,
  classNames: string[],
  state: AssembleState,
): Promise<Record<string, TypedValue>> {
  const settings: Record<string, TypedValue> = {};
  for (const [prop, raw] of Object.entries(node.settings_seed)) {
    if (prop === 'classes') {
      continue; // handled below via the mirror so local-style ids are always present
    }
    if (isMediaPending(raw)) {
      const pending = raw.__media_pending;
      if (prop === 'svg') {
        // e-svg's `svg` prop is `Svg_Src_Prop_Type` (`{$$type:'svg-src',value:{id,url}}`) — an
        // `image` envelope is rejected by PHP (`svg: invalid_value`). Inline markup is uploaded.
        // The envelope follows the PROP, never the media KIND: an `<img src="x.svg">` maps to
        // e-image, whose `image` prop must carry an `image` envelope — the old `|| kind === 'svg'`
        // clause routed it here and stuffed svg-src into `image`, and PHP rejected the whole
        // commit with `image: invalid_value` (field-found on a live-site convert, 2026-07-01).
        const svg = await resolveSvgSrc(pending, node.source_path, state);
        if (svg !== null) {
          settings[prop] = svg;
        }
        continue;
      }
      const src = await resolveImageSrc(pending, node.source_path, state);
      if (src !== null && isValidImageSrc(src)) {
        // `image`/`source` props that carry an image → `image` envelope.
        settings[prop] = buildImage(src);
      }
      continue;
    }
    const wrapped = wrapSettingValue(prop, raw);
    if (wrapped !== undefined) {
      settings[prop] = wrapped;
    }
  }
  // ALWAYS emit `classes` (BARE string array) carrying global ids + the mirrored local-style ids.
  settings['classes'] = classesValue(classNames);
  return settings;
}

/** Carry the MAP suggested-name into `editor_settings.title` (widget) for editor legibility. */
function widgetEditorSettings(node: StyledNode): Record<string, unknown> | undefined {
  // The IR carries no explicit name field beyond the seed text; reuse the heading/text seed as a label.
  const seed = node.settings_seed;
  const label = seed['title'] ?? seed['text'] ?? seed['paragraph'];
  if (typeof label === 'string' && label !== '') {
    return { title: label.slice(0, 80) };
  }
  return undefined;
}

/**
 * Assemble ONE node (and its subtree) into an `ElementNode`. Mints the element id FIRST, finalizes +
 * mirrors local styles, resolves media, wraps envelopes, then recurses into children in document order.
 */
async function assembleNode(node: StyledNode, state: AssembleState): Promise<ElementNode> {
  const elementId = mintUniqueId(state.usedIds);
  state.mintedIds.push(elementId);
  const target = node.target;

  // Children are assembled in document order (depth-first, ids already minted for this node). The
  // frozen `StyledNode` inherits `children: MappedNode[]` from `MappedNode` (the intersection does not
  // re-narrow it), but STYLE-EXTRACT (WP-H07) produces `StyledNode` children at runtime — annotate to
  // keep TS from widening under `exactOptionalPropertyTypes` (the same pattern STYLE-EXTRACT uses).
  const children: ElementNode[] = [];
  for (const child of node.children as StyledNode[]) {
    children.push(await assembleNode(child, state));
  }

  if (!isAtomicTarget(target) || state.ctx.generation === 'v3') {
    return buildClassicNode(node, elementId, children, state);
  }

  // ── Finalize local styles + mirror their ids into classes (§5.1 HARD) ──────────────────────────
  const { stylesMap, ids: localIds } = finalizeLocalStyles(elementId, node.local_styles, state);
  const classNames = [...localIds];

  // ── Opt-in source-class preservation (stable enhancement anchors that survive re-converts) ─────
  if (state.ctx.preserve_source_classes === true) {
    classNames.push(...sourceClassNames(node.attrs['class']));
  }

  // ── Background-image media → style overlay (id-only src, §3.2) ────────────────────────────────
  if (node.media?.kind === 'background') {
    const src = await resolveImageSrc(node.media, node.source_path, state);
    if (src !== null && isValidImageSrc(src)) {
      const extraStyleId = applyBackgroundOverlay(
        src,
        elementId,
        stylesMap,
        state,
        backgroundOverlayRiders(node.computed),
      );
      if (extraStyleId !== null) {
        classNames.push(extraStyleId);
      }
    }
  }

  // ── Settings (wrap envelopes; resolve <img>/svg media; always include classes) ────────────────
  const settings = await buildAtomicSettings(node, classNames, state);

  // ── §5.1 mirror invariant pre-check (every styles-map id present in classes) ───────────────────
  assertLocalStyleMirror(elementId, stylesMap, settings['classes']);

  if (typeof target.widgetType === 'string' && target.widgetType.startsWith('e-')) {
    // Only CHILD-BEARING atomic widgets (e-tab-content) keep their assembled children. Every other
    // atomic widget is a LEAF — emit it with an EMPTY `elements[]`. Any children that reached here
    // (NORMALIZE should have folded inline text in; an SVG-wrapper div that slipped through MAP) are
    // dropped AND their finalized local-style ids pruned from the pass state, so the reference closure
    // holds (contract 17 I1 — the page-1704 dangling-ref fix; see CHILD_BEARING_ATOMIC_WIDGETS).
    const isChildBearing = CHILD_BEARING_ATOMIC_WIDGETS.has(target.widgetType);
    const widgetElements = isChildBearing ? children : [];
    if (!isChildBearing && children.length > 0) {
      pruneDroppedSubtreeStyles(children, state);
    }
    const widget: AtomicWidgetNode = {
      id: elementId,
      elType: 'widget',
      widgetType: target.widgetType as AtomicWidgetType,
      version: '0.0',
      settings,
      styles: stylesMap,
      editor_settings: widgetEditorSettings(node) ?? {},
      interactions: [],
      elements: widgetElements,
    };
    return widget;
  }

  // A `widget` elType MUST never be emitted without a resolvable atomic `widgetType` — Elementor's
  // frontend fatals on a typeless widget ("Undefined array key widgetType", document.php → HTTP 500).
  // If we land here with `elType:'widget'` (no `e-*` widgetType), fall back to a leaf `e-paragraph`
  // carrying whatever text/content was seeded (ticket req 2c — never a typeless widget). Containers
  // (e-div-block/e-flexbox/e-tabs/…) are emitted as-is below.
  if (target.elType === 'widget') {
    // The fallback e-paragraph is a leaf — drop any assembled children + prune their style ids so
    // the reference closure holds (contract 17 I1).
    if (children.length > 0) {
      pruneDroppedSubtreeStyles(children, state);
    }
    const widget: AtomicWidgetNode = {
      id: elementId,
      elType: 'widget',
      widgetType: 'e-paragraph',
      version: '0.0',
      settings,
      styles: stylesMap,
      editor_settings: widgetEditorSettings(node) ?? {},
      interactions: [],
      elements: [],
    };
    return widget;
  }

  const container: AtomicContainerNode = {
    id: elementId,
    elType: target.elType as AtomicContainerType,
    version: '0.0',
    settings,
    styles: stylesMap,
    editor_settings: [],
    interactions: [],
    elements: children,
  };
  return container;
}

/**
 * Classic NESTED widgets — their item content lives in child `container` elements (e.g. the
 * recon-verified classic `nested-accordion` emitted INSIDE a V4 document by the contract-16 §3
 * accordion restructure, whose `items` repeater pairs positionally with one child container per
 * item). Unlike flat classic widgets (forced leaves — a typeless/flat widget with element children
 * breaks the frontend), these MUST keep their assembled children.
 */
const NESTED_CLASSIC_WIDGETS: ReadonlySet<string> = new Set(['nested-accordion', 'nested-tabs']);

/**
 * Build a V3 CLASSIC fallback node (flat settings, no styles map). Uses the `v3_fallback` target type.
 * Settings carry RAW control values (no typed envelopes); responsive/group handling is the V3 author's
 * job upstream — ASSEMBLE only flattens the role-driven seed it received.
 */
function buildClassicNode(
  node: StyledNode,
  elementId: string,
  children: ElementNode[],
  state: AssembleState,
): ClassicNode {
  const fallback = node.target.v3_fallback;
  const settings: Record<string, unknown> = {};
  for (const [prop, raw] of Object.entries(node.settings_seed)) {
    if (prop === 'classes' || isMediaPending(raw)) {
      continue;
    }
    if (isLinkSeed(raw)) {
      settings['link'] = {
        url: raw.destination,
        is_external: raw.isTargetBlank === true ? 'on' : '',
      };
      continue;
    }
    settings[prop] = raw;
  }
  const elType = fallback.elType as ClassicNode['elType'];
  const classic: ClassicNode = {
    id: elementId,
    elType,
    settings,
    elements: children,
  };
  if (elType === 'widget') {
    // A `widget` elType MUST carry a widgetType or Elementor's frontend fatals (typeless widget →
    // HTTP 500). Use the rule's V3 fallback widget when present, else the safe `text-editor` text
    // widget (ticket req 2c — never a typeless widget). A flat classic widget is a leaf — drop
    // children; NESTED classic widgets (nested-accordion/nested-tabs) keep their item containers.
    classic.widgetType =
      typeof fallback.widgetType === 'string' && fallback.widgetType !== ''
        ? fallback.widgetType
        : 'text-editor';
    classic.elements = NESTED_CLASSIC_WIDGETS.has(classic.widgetType) ? children : [];
    if (classic.elements.length === 0 && children.length > 0) {
      // Flat classic widget = leaf: the dropped children may be ATOMIC subtrees whose finalized
      // local-style ids must be pruned from the pass state (contract 17 I1 reference closure).
      pruneDroppedSubtreeStyles(children, state);
    }
  }
  return classic;
}

/* ─────────────────────────── §5.1 mirror invariant pre-check ─────────────────────────────────── */

/**
 * Enforce the §5.1 HARD rule before returning: EVERY id in the `styles` map MUST also be present in the
 * element's `settings.classes.value`. A violation is a programming error in ASSEMBLE (the mirror is
 * built here) — throw a `LOCAL_STYLE_UNLINKED`-shaped error so it surfaces in tests / before dry_run.
 */
function assertLocalStyleMirror(
  elementId: string,
  stylesMap: Record<string, StyleDefinition>,
  classesEnvelope: TypedValue | undefined,
): void {
  const classNames =
    classesEnvelope !== undefined && Array.isArray((classesEnvelope as Classes).value)
      ? new Set((classesEnvelope as Classes).value)
      : new Set<string>();
  for (const styleId of Object.keys(stylesMap)) {
    if (!classNames.has(styleId)) {
      throw new Error(
        `LOCAL_STYLE_UNLINKED: local style "${styleId}" on element "${elementId}" is in the styles map ` +
          `but absent from settings.classes.value (authoring-contract §5.1).`,
      );
    }
  }
}

/* ─────────────────────────── reference closure, tree-wide (contract 17 I1) ───────────────────── */

/**
 * Enforce contract 17 I1 (reference closure, BOTH directions) across the WHOLE assembled tree:
 *
 *   1. every id in a node's `settings.classes.value` resolves to a definition in that node's
 *      `styles` map — at the ASSEMBLE seam every classes entry is assemble-minted and LOCAL (HOIST
 *      runs later and swaps local ids for kit `g-*` ids), so an unresolved ref here is ALWAYS a
 *      converter bug (page 1704: 12 dangling refs → zero-size icons + deterministic CSS_PRIME_FAILED);
 *   2. every `styles`-map id is referenced by its own node's classes (§5.1 — the per-node
 *      `assertLocalStyleMirror` covers nodes as they are built; this re-check also covers any
 *      post-assembly restructuring such as the leaf-widget child drop).
 *
 * Classic nodes carry neither a `classes` envelope nor a `styles` map and are skipped. Violations are
 * programming errors in ASSEMBLE — throw so they surface in tests / before dry_run, never persist.
 */
function assertReferenceClosure(elements: ElementNode[]): void {
  const walk = (nodes: ElementNode[]): void => {
    for (const node of nodes) {
      const settings = (node as { settings?: Record<string, unknown> }).settings;
      const classesEnvelope = settings?.['classes'];
      const stylesMap = (node as { styles?: Record<string, StyleDefinition> }).styles ?? {};
      const styleIds = Object.keys(stylesMap);
      if (isClassesValue(classesEnvelope)) {
        const defined = new Set(styleIds);
        for (const ref of classesEnvelope.value) {
          // Preserved SOURCE classes (opt-in `preserve_source_classes`) are plain semantic tokens,
          // never style refs — only assemble-minted local ids (`e-…`) must resolve to a style def.
          // The sanitizer skips every `e-`-prefixed source token, so the shape is the discriminator.
          if (!ref.startsWith('e-')) {
            continue;
          }
          if (!defined.has(ref)) {
            throw new Error(
              `DANGLING_CLASS_REF: element "${node.id}" references class "${ref}" in ` +
                `settings.classes.value but carries no matching style definition (contract 17 I1 — ` +
                `every assemble-emitted class ref MUST resolve to a node-local style).`,
            );
          }
        }
        const referenced = new Set(classesEnvelope.value);
        for (const styleId of styleIds) {
          if (!referenced.has(styleId)) {
            throw new Error(
              `LOCAL_STYLE_UNLINKED: local style "${styleId}" on element "${node.id}" is in the ` +
                `styles map but absent from settings.classes.value (authoring-contract §5.1 / ` +
                `contract 17 I1).`,
            );
          }
        }
      } else if (styleIds.length > 0) {
        throw new Error(
          `LOCAL_STYLE_UNLINKED: element "${node.id}" carries ${String(styleIds.length)} local ` +
            `style(s) but no classes envelope to reference them (contract 17 I1).`,
        );
      }
      if (Array.isArray(node.elements) && node.elements.length > 0) {
        walk(node.elements);
      }
    }
  };
  walk(elements);
}

/* ─────────────────────────── tabs structural integrity (§4) ──────────────────────────────────── */

/**
 * Verify `e-tabs` structural integrity (authoring-contract §4 "tab & content counts MUST match"): each
 * `e-tabs` node must hold an `e-tabs-menu` whose `e-tab` count equals the `e-tab-content` count in its
 * `e-tabs-content-area`. ASSEMBLE preserves whatever MAP paired (it does not invent tabs); this is a
 * defensive post-assembly assertion so a mis-paired tree never reaches dry_run silently.
 */
function assertTabsIntegrity(elements: ElementNode[]): void {
  const walk = (nodes: ElementNode[]): void => {
    for (const node of nodes) {
      if (node.elType === 'e-tabs') {
        const kids = node.elements ?? [];
        const menu = kids.find((k) => k.elType === 'e-tabs-menu');
        const area = kids.find((k) => k.elType === 'e-tabs-content-area');
        const tabCount = (menu?.elements ?? []).filter((k) => k.elType === 'e-tab').length;
        const contentCount = (area?.elements ?? []).filter(
          (k) => k.elType === 'e-tab-content',
        ).length;
        if (tabCount !== contentCount) {
          throw new Error(
            `e-tabs structural mismatch on element "${node.id}": ${String(tabCount)} e-tab vs ` +
              `${String(contentCount)} e-tab-content (authoring-contract §4 — counts MUST match).`,
          );
        }
      }
      if (Array.isArray(node.elements) && node.elements.length > 0) {
        walk(node.elements);
      }
    }
  };
  walk(elements);
}

/* ─────────────────────────── entry point ─────────────────────────────────────────────────────── */

/**
 * ASSEMBLE: turn a `StyledNode[]` forest into the final `ElementNode[]` authoring tree, minting unique
 * element + local-style ids, mirroring local styles into `classes` (§5.1), sideloading media to id-only
 * `image-src` (§3.2), and wrapping every value in its typed envelope (§3). Returns the `AssembleResult`
 * (tree + media map + non-fatal sideload errors + the minted id sets).
 *
 * Async because of media I/O (the FIRST convert stage that touches the WP — via the injected
 * `MediaPort`/`IdPort`, never a direct client import). Document order is preserved.
 */
export async function assembleTree(
  styled: StyledNode[],
  ctx: AssembleContext,
): Promise<AssembleResult> {
  const state: AssembleState = {
    ctx,
    usedIds: new Set(ctx.existing_ids),
    cache: new SideloadCache(),
    mediaMap: {},
    sideloadErrors: [],
    mintedIds: [],
    localStyleIds: [],
  };

  // Optionally fold the live document's used-id set in for cross-document collision avoidance (§8.1).
  try {
    const extra = await ctx.ids.validate(state.mintedIds);
    for (const id of extra) {
      state.usedIds.add(id);
    }
  } catch {
    // `IdPort.validate` is best-effort (cross-document hint); a failure never aborts the assemble.
  }

  const elements: ElementNode[] = [];
  for (const node of styled) {
    elements.push(await assembleNode(node, state));
  }

  // Defensive structural assertion for the e-tabs family (counts MUST match, §4).
  assertTabsIntegrity(elements);

  // Reference closure, tree-wide (contract 17 I1): every emitted class ref resolves to a style
  // definition on its node AND every style definition is referenced — both directions, post-drop.
  assertReferenceClosure(elements);

  return {
    elements,
    media_map: state.mediaMap,
    sideload_errors: state.sideloadErrors,
    minted_ids: state.mintedIds,
    local_style_ids: state.localStyleIds,
  };
}
