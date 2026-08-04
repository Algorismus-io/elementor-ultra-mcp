/**
 * WP-H08 — ASSEMBLE stage unit tests.
 *
 * Covers (acceptance criteria, ticket §Tests Required), with STUBBED `MediaPort`/`IdPort` (no live WP):
 *   - id minting + dedupe (unique 7-hex; none collide in-tree or against `existing_ids`);
 *   - local-style finalization + §5.1 mirroring (every styles-map id present in `settings.classes.value`);
 *   - image sideload → id-only `image-src` (id-XOR-url HARD); url-only on sideload-disabled; degrade on
 *     sideload failure (non-fatal, recorded in `sideload_errors`); background-image → style overlay;
 *   - envelope wrapping (bare `classes`; html-v3 `{content,children}` for title/text/paragraph; link;
 *     UNION single-wrap for the link destination url);
 *   - tabs pairing integrity; sideload cache (no double sideload of the same url);
 *   - structural validation of the produced tree against `element-node.schema.json` (Ajv2020).
 *
 * The full S3 corpus round-trip through PHP `dry_run` is asserted in WP-H10's corpus suite (Contract 14
 * §6), not here — these are pure unit tests on synthetic `StyledNode[]` fixtures.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchemaObject, ValidateFunction } from 'ajv';

import { assembleTree } from './assemble.js';
import { isValidImageSrc, isClassesValue } from '../authoring/envelopes.js';
import { collectIds } from '../authoring/ids.js';
import { isAtomicWidgetNode, isAtomicContainerNode } from '../authoring/contract.js';
import type {
  AtomicContainerNode,
  AtomicWidgetNode,
  ClassicNode,
  ElementNode,
  Classes,
  TypedValue,
} from '../authoring/contract.js';
import type {
  AssembleContext,
  BoxRect,
  IdPort,
  IrNode,
  MappingResult,
  MediaPort,
  MediaRef,
  StyleDefinition,
  StyledNode,
} from './types.js';

/* ─────────────────────────── tiny StyledNode + port builders ─────────────────────────────────── */

const ZERO_BOX: BoxRect = { x: 0, y: 0, width: 0, height: 0 };

/** A V4 atomic target for a widget (`e-*` widgetType). */
function widgetTarget(widgetType: string, elType = 'widget'): MappingResult {
  return {
    generation: 'v4',
    elType,
    widgetType,
    is_container: false,
    settings_seed: {},
    v3_fallback: { elType: 'widget', widgetType: 'heading' },
  };
}

/** A V4 atomic target for a container (`e-*` elType, no widgetType). */
function containerTarget(elType: string, tag?: string): MappingResult {
  const base: MappingResult = {
    generation: 'v4',
    elType,
    is_container: true,
    settings_seed: tag !== undefined ? { tag } : {},
    v3_fallback: { elType: 'container' },
  };
  return tag !== undefined ? { ...base, tag } : base;
}

/** A simple base (desktop, normal) StyleDefinition with one prop (placeholder id is rewritten). */
function localStyle(prop: string, value: TypedValue): StyleDefinition {
  return {
    id: 'e-local-1234567',
    type: 'class',
    label: 'local',
    variants: [{ meta: { breakpoint: 'desktop', state: null }, props: { [prop]: value } }],
  };
}

/** Build a synthetic `StyledNode` (post STYLE-EXTRACT) for the assemble unit tests. */
function styled(
  partial: Partial<IrNode> & { source_path: string; tag: string } & {
    target: MappingResult;
    settings_seed?: Record<string, unknown>;
    local_styles?: StyleDefinition[];
    children?: StyledNode[];
  },
): StyledNode {
  const seed = partial.settings_seed ?? partial.target.settings_seed;
  return {
    source_path: partial.source_path,
    tag: partial.tag,
    role: partial.role ?? 'unknown',
    box: partial.box ?? ZERO_BOX,
    computed: partial.computed ?? {},
    responsive: partial.responsive ?? {},
    attrs: partial.attrs ?? {},
    textRuns: partial.textRuns ?? [],
    ...(partial.media !== undefined ? { media: partial.media } : {}),
    target: partial.target,
    settings_seed: seed,
    local_styles: partial.local_styles ?? [],
    decl_index: {},
    children: partial.children ?? [],
  };
}

/** A stub `MediaPort`: assigns deterministic ids per url; `failUrls` makes sideload throw. */
function stubMedia(opts: { failUrls?: Set<string> } = {}): MediaPort & { calls: string[] } {
  let next = 100;
  const calls: string[] = [];
  return {
    calls,
    sideloadUrl: vi.fn((url: string) => {
      calls.push(url);
      if (opts.failUrls?.has(url) === true) {
        return Promise.reject(new Error(`sideload failed: ${url}`));
      }
      const id = next;
      next += 1;
      return Promise.resolve({ id, url: `https://wp.local/wp-content/uploads/${String(id)}.png` });
    }),
    upload: vi.fn(() => Promise.resolve({ id: 999, url: 'https://wp.local/up.png' })),
  };
}

/** A stub `IdPort`: `validate` returns the extra used-ids the live document already has. */
function stubIds(extraUsed: string[] = []): IdPort {
  return {
    mint: (used: Set<string>) => {
      // Not used by ASSEMBLE (it mints via ids.ts directly); provide a trivial impl for completeness.
      let n = 0;
      let id = `s${String(n)}`;
      while (used.has(id)) {
        n += 1;
        id = `s${String(n)}`;
      }
      used.add(id);
      return id;
    },
    validate: vi.fn(() => Promise.resolve(extraUsed)),
  };
}

function context(overrides: Partial<AssembleContext> = {}): AssembleContext {
  return {
    generation: 'v4',
    existing_ids: new Set<string>(),
    sideload_media: true,
    media: stubMedia(),
    ids: stubIds(),
    ...overrides,
  };
}

function strEnvelope(value: string): TypedValue {
  return { $$type: 'string', value };
}

function imgMedia(url: string, alt?: string): MediaRef {
  return alt !== undefined ? { kind: 'img', url, alt } : { kind: 'img', url };
}

/* ─────────────────────────── id minting + dedupe ─────────────────────────────────────────────── */

describe('assembleTree — id minting + dedupe (criterion: unique 7-hex)', () => {
  it('every produced element has a unique 7-hex id', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'a',
        tag: 'div',
        target: containerTarget('e-div-block', 'div'),
        children: [
          styled({ source_path: 'a>h1', tag: 'h1', target: widgetTarget('e-heading') }),
          styled({ source_path: 'a>p', tag: 'p', target: widgetTarget('e-paragraph') }),
        ],
      }),
    ];
    const res = await assembleTree(tree, context());
    const ids = collectIds(res.elements);
    expect(ids.size).toBe(3); // no collisions in-tree
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{7}$/); // 7 hex chars, lowercase
    }
    expect(res.minted_ids.length).toBe(3);
    expect(new Set(res.minted_ids).size).toBe(3);
  });

  it('never collides against existing_ids (deduped on mint)', async () => {
    // Force a near-exhausted random source by pre-populating existing_ids; mint must still avoid them.
    const existing = new Set<string>(['aaaaaaa', 'bbbbbbb']);
    const tree: StyledNode[] = [
      styled({ source_path: 'x', tag: 'div', target: containerTarget('e-div-block', 'div') }),
    ];
    const res = await assembleTree(tree, context({ existing_ids: existing }));
    for (const id of res.minted_ids) {
      expect(existing.has(id)).toBe(false);
    }
  });

  it('folds the IdPort.validate used-id set in (cross-document collision avoidance, §8.1)', async () => {
    const validate = vi.fn(() => Promise.resolve(['cccccc1', 'dddddd2']));
    const ids: IdPort = { ...stubIds(), validate };
    const tree: StyledNode[] = [
      styled({ source_path: 'x', tag: 'div', target: containerTarget('e-div-block', 'div') }),
    ];
    const res = await assembleTree(tree, context({ ids }));
    expect(validate).toHaveBeenCalledOnce();
    for (const id of res.minted_ids) {
      expect(['cccccc1', 'dddddd2'].includes(id)).toBe(false);
    }
  });

  it('survives an IdPort.validate failure (best-effort, non-fatal)', async () => {
    const ids: IdPort = {
      ...stubIds(),
      validate: vi.fn(() => Promise.reject(new Error('network'))),
    };
    const tree: StyledNode[] = [
      styled({ source_path: 'x', tag: 'div', target: containerTarget('e-div-block', 'div') }),
    ];
    const res = await assembleTree(tree, context({ ids }));
    expect(res.elements.length).toBe(1);
  });
});

/* ─────────────────────────── local-style finalization + §5.1 mirror ──────────────────────────── */

describe('assembleTree — local-style finalization + mirroring (§5.1 HARD)', () => {
  it('rewrites placeholder local-style ids to e-<elementId>-<7hex> and mirrors into classes', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'a',
        tag: 'div',
        target: containerTarget('e-div-block', 'div'),
        local_styles: [localStyle('display', strEnvelope('flex'))],
      }),
    ];
    const res = await assembleTree(tree, context());
    const node = res.elements[0] as AtomicContainerNode;
    const styleIds = Object.keys(node.styles ?? {});
    expect(styleIds.length).toBe(1);
    // id form e-<elementId>-<7hex>
    expect(styleIds[0]).toMatch(new RegExp(`^e-${node.id}-[0-9a-f]{7}$`));
    // §5.1 mirror: the style id is present in settings.classes.value
    const classes = node.settings['classes'] as Classes;
    expect(classes.value).toContain(styleIds[0]);
    // the StyleDefinition's own `id` field is rewritten to match the map key
    expect(node.styles?.[styleIds[0]!]?.id).toBe(styleIds[0]);
    expect(res.local_style_ids).toContain(styleIds[0]);
  });

  it('EVERY styles-map id is present in classes for every node (mirror invariant)', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'a',
        tag: 'div',
        target: containerTarget('e-div-block', 'div'),
        local_styles: [localStyle('display', strEnvelope('flex'))],
        children: [
          styled({
            source_path: 'a>h1',
            tag: 'h1',
            target: widgetTarget('e-heading'),
            settings_seed: { tag: 'h1', title: 'Hi' },
            local_styles: [localStyle('color', { $$type: 'color', value: '#000' })],
          }),
        ],
      }),
    ];
    const res = await assembleTree(tree, context());
    const checkMirror = (nodes: ElementNode[]): void => {
      for (const n of nodes) {
        if (isAtomicContainerNode(n) || isAtomicWidgetNode(n)) {
          const classes = (n.settings['classes'] as Classes | undefined)?.value ?? [];
          for (const sid of Object.keys(n.styles ?? {})) {
            expect(classes).toContain(sid);
          }
        }
        if (n.elements) checkMirror(n.elements);
      }
    };
    checkMirror(res.elements);
  });

  it('local-style ids are unique across sibling nodes (no shared local id)', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'wrap',
        tag: 'div',
        target: containerTarget('e-div-block', 'div'),
        children: [
          styled({
            source_path: 'wrap>a',
            tag: 'div',
            target: containerTarget('e-div-block', 'div'),
            local_styles: [localStyle('display', strEnvelope('flex'))],
          }),
          styled({
            source_path: 'wrap>b',
            tag: 'div',
            target: containerTarget('e-div-block', 'div'),
            local_styles: [localStyle('display', strEnvelope('block'))],
          }),
        ],
      }),
    ];
    const res = await assembleTree(tree, context());
    expect(new Set(res.local_style_ids).size).toBe(res.local_style_ids.length);
    expect(res.local_style_ids.length).toBe(2);
  });
});

/* ─────────────────────────── source-class preservation (opt-in) ──────────────────────────────── */

describe('assembleTree — preserve_source_classes (stable enhancement anchors)', () => {
  const attrs = {
    class: 'rk-band rk-band--wide e-con elementor-widget g-abc 2bad -ok_name rk-band',
  };

  it('OPT-IN: sanitized source classes land in settings.classes AFTER the local-style ids', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'sec',
        tag: 'section',
        target: containerTarget('e-div-block', 'section'),
        attrs,
        local_styles: [localStyle('display', strEnvelope('block'))],
      }),
    ];
    const res = await assembleTree(tree, context({ preserve_source_classes: true }));
    const node = res.elements[0] as AtomicWidgetNode;
    const classes = (node.settings['classes'] as TypedValue).value as string[];
    // local-style id first (§5.1 mirror), then the sanitized source classes: system prefixes
    // (e-/g-/elementor*) skipped, contract-invalid tokens (2bad, -ok_name — R7 requires a leading
    // letter) skipped, dupe deduped.
    expect(classes[0]).toMatch(/^e-/);
    expect(classes.slice(1)).toEqual(['rk-band', 'rk-band--wide']);
  });

  it('DEFAULT OFF: classes carry only local-style ids (surface unchanged)', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'sec',
        tag: 'section',
        target: containerTarget('e-div-block', 'section'),
        attrs,
        local_styles: [localStyle('display', strEnvelope('block'))],
      }),
    ];
    const res = await assembleTree(tree, context());
    const node = res.elements[0] as AtomicWidgetNode;
    const classes = (node.settings['classes'] as TypedValue).value as string[];
    expect(classes.every((c) => /^e-/.test(c))).toBe(true);
  });
});

/* ─────────────────────────── image sideload → id-XOR-url image-src (§3.2) ─────────────────────── */

describe('assembleTree — image sideload → id-only image-src (§3.2 HARD)', () => {
  it('an <img> produces image.src with id ONLY (no url) after sideload', async () => {
    const media = stubMedia();
    const tree: StyledNode[] = [
      styled({
        source_path: 'img',
        tag: 'img',
        target: widgetTarget('e-image'),
        settings_seed: { image: { __media_pending: imgMedia('https://x/y.png', 'logo') } },
      }),
    ];
    const res = await assembleTree(tree, context({ media }));
    const node = res.elements[0] as AtomicWidgetNode;
    const image = node.settings['image'] as TypedValue;
    expect(image.$$type).toBe('image');
    const src = (image.value as { src: TypedValue }).src;
    expect(isValidImageSrc(src)).toBe(true); // id-XOR-url holds
    const inner = src.value as { id?: TypedValue; url?: TypedValue };
    expect(inner.id).toBeDefined();
    expect(inner.url).toBeUndefined(); // id ONLY, never url
    expect(inner.id?.$$type).toBe('image-attachment-id');
    expect(res.media_map['https://x/y.png']).toBe(100);
  });

  it('an <img src="x.svg"> (media kind svg on an e-image) still emits an IMAGE envelope — never svg-src', async () => {
    // Field bug (live-site convert, 2026-07-01): the fill routed by media KIND, stuffing an svg-src
    // envelope into e-image's `image` prop → PHP rejected the whole commit with `image: invalid_value`.
    // The envelope must follow the PROP: `image` prop → image envelope, whatever the file type.
    const media = stubMedia();
    const tree: StyledNode[] = [
      styled({
        source_path: 'img.svg',
        tag: 'img',
        target: widgetTarget('e-image'),
        settings_seed: {
          image: { __media_pending: { kind: 'svg', url: 'https://x/logo.svg', alt: 'logo' } },
        },
      }),
    ];
    const res = await assembleTree(tree, context({ media }));
    const node = res.elements[0] as AtomicWidgetNode;
    const image = node.settings['image'] as TypedValue;
    expect(image.$$type).toBe('image'); // NOT 'svg-src'
    const src = (image.value as { src: TypedValue }).src;
    expect(src.$$type).toBe('image-src');
    expect(isValidImageSrc(src)).toBe(true);
    const inner = src.value as { id?: TypedValue };
    expect(inner.id?.$$type).toBe('image-attachment-id'); // sideloaded id-only
  });

  it('sideload DISABLED → url-only image-src (true external), never both/neither', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'img',
        tag: 'img',
        target: widgetTarget('e-image'),
        settings_seed: { image: { __media_pending: imgMedia('https://ext/z.png') } },
      }),
    ];
    const res = await assembleTree(tree, context({ sideload_media: false }));
    const node = res.elements[0] as AtomicWidgetNode;
    const src = (node.settings['image']!.value as { src: TypedValue }).src;
    expect(isValidImageSrc(src)).toBe(true);
    const inner = src.value as { id?: TypedValue; url?: TypedValue };
    expect(inner.url).toBeDefined();
    expect(inner.id).toBeUndefined();
    expect(inner.url?.$$type).toBe('url');
  });

  it('sideload FAILURE is non-fatal: recorded in sideload_errors, node degrades to url-only', async () => {
    const media = stubMedia({ failUrls: new Set(['https://bad/p.png']) });
    const tree: StyledNode[] = [
      styled({
        source_path: 'img',
        tag: 'img',
        target: widgetTarget('e-image'),
        settings_seed: { image: { __media_pending: imgMedia('https://bad/p.png') } },
      }),
    ];
    const res = await assembleTree(tree, context({ media }));
    expect(res.sideload_errors.length).toBe(1);
    expect(res.sideload_errors[0]?.url).toBe('https://bad/p.png');
    expect(res.sideload_errors[0]?.source_path).toBe('img');
    const src = (res.elements[0] as AtomicWidgetNode).settings['image']!.value as {
      src: TypedValue;
    };
    const inner = src.src.value as { id?: TypedValue; url?: TypedValue };
    expect(inner.url).toBeDefined(); // degraded to url-only (still XOR-valid)
    expect(inner.id).toBeUndefined();
  });

  it('the same source url is sideloaded only once per run (cache)', async () => {
    const media = stubMedia();
    const tree: StyledNode[] = [
      styled({
        source_path: 'a',
        tag: 'div',
        target: containerTarget('e-div-block', 'div'),
        children: [
          styled({
            source_path: 'a>i1',
            tag: 'img',
            target: widgetTarget('e-image'),
            settings_seed: { image: { __media_pending: imgMedia('https://dup/same.png') } },
          }),
          styled({
            source_path: 'a>i2',
            tag: 'img',
            target: widgetTarget('e-image'),
            settings_seed: { image: { __media_pending: imgMedia('https://dup/same.png') } },
          }),
        ],
      }),
    ];
    const res = await assembleTree(tree, context({ media }));
    expect(media.calls.filter((u) => u === 'https://dup/same.png').length).toBe(1);
    // Both images resolve to the SAME attachment id.
    const grandkids = (res.elements[0] as AtomicContainerNode).elements ?? [];
    const ids = grandkids.map((g): unknown => {
      const src = (g as AtomicWidgetNode).settings['image']!.value as { src: TypedValue };
      const inner = src.src.value as { id?: TypedValue };
      return inner.id?.value as unknown;
    });
    expect(ids[0]).toBe(ids[1]);
  });

  it('a background-image sideloads and sets the atomic background overlay src id-only', async () => {
    const media = stubMedia();
    const tree: StyledNode[] = [
      styled({
        source_path: 'hero',
        tag: 'section',
        target: containerTarget('e-div-block', 'section'),
        media: { kind: 'background', url: 'https://bg/hero.jpg' },
        local_styles: [localStyle('display', strEnvelope('flex'))],
      }),
    ];
    const res = await assembleTree(tree, context({ media }));
    const node = res.elements[0] as AtomicContainerNode;
    // The background overlay lives in a style variant prop, with an id-only image-src.
    const styleDef = Object.values(node.styles ?? {})[0]!;
    const baseVariant = styleDef.variants.find(
      (v) => v.meta.breakpoint === 'desktop' && v.meta.state === null,
    )!;
    const bg = baseVariant.props['background'] as TypedValue;
    expect(bg.$$type).toBe('background');
    const overlayArr = (bg.value as { 'background-overlay': TypedValue })['background-overlay']
      .value as TypedValue[];
    const overlay = overlayArr[0]!;
    expect(overlay.$$type).toBe('background-image-overlay');
    const imgSrc = ((overlay.value as { image: TypedValue }).image.value as { src: TypedValue })
      .src;
    expect(isValidImageSrc(imgSrc)).toBe(true);
    const inner = imgSrc.value as { id?: TypedValue; url?: TypedValue };
    expect(inner.id).toBeDefined();
    expect(inner.url).toBeUndefined();
    expect(res.media_map['https://bg/hero.jpg']).toBe(100);
  });

  it('background riders (size/repeat/position) ride the overlay from the computed longhands', async () => {
    // W18 band-12 guard: without the riders the widget default TILED the sideloaded photo at
    // natural size (zoomed seam instead of one cover photo).
    const media = stubMedia();
    const tree: StyledNode[] = [
      styled({
        source_path: 'hero',
        tag: 'section',
        target: containerTarget('e-div-block', 'section'),
        media: { kind: 'background', url: 'https://bg/hero.jpg' },
        computed: {
          'background-size': 'cover',
          'background-repeat': 'no-repeat',
          'background-position': 'center center',
        },
        local_styles: [localStyle('display', strEnvelope('flex'))],
      }),
    ];
    const res = await assembleTree(tree, context({ media }));
    const node = res.elements[0] as AtomicContainerNode;
    const styleDef = Object.values(node.styles ?? {})[0]!;
    const baseVariant = styleDef.variants.find(
      (v) => v.meta.breakpoint === 'desktop' && v.meta.state === null,
    )!;
    const bg = baseVariant.props['background'] as TypedValue;
    const overlayArr = (bg.value as { 'background-overlay': TypedValue })['background-overlay']
      .value as TypedValue[];
    const overlayValue = overlayArr[0]!.value as Record<string, TypedValue>;
    expect(overlayValue['size']).toEqual({ $$type: 'string', value: 'cover' });
    expect(overlayValue['repeat']).toEqual({ $$type: 'string', value: 'no-repeat' });
    expect(overlayValue['position']).toEqual({ $$type: 'string', value: 'center center' });
  });
});

/* ─────────────────────────── envelope wrapping (§3) ──────────────────────────────────────────── */

describe('assembleTree — envelope wrapping (§3)', () => {
  it('classes is a BARE string array envelope (never per-item wrapped)', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'a',
        tag: 'div',
        target: containerTarget('e-div-block', 'div'),
        local_styles: [localStyle('display', strEnvelope('flex'))],
      }),
    ];
    const res = await assembleTree(tree, context());
    const classes = (res.elements[0] as AtomicContainerNode).settings['classes'];
    expect(isClassesValue(classes)).toBe(true);
  });

  it('a heading title is wrapped as html-v3 {content,children}', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'h',
        tag: 'h1',
        target: widgetTarget('e-heading'),
        settings_seed: { tag: 'h1', title: 'Welcome' },
      }),
    ];
    const res = await assembleTree(tree, context());
    const node = res.elements[0] as AtomicWidgetNode;
    const title = node.settings['title'] as TypedValue;
    expect(title.$$type).toBe('html-v3');
    const inner = title.value as { content: TypedValue; children: unknown[] };
    expect(inner.content.$$type).toBe('string');
    expect(inner.content.value).toBe('Welcome');
    expect(Array.isArray(inner.children)).toBe(true);
    // a plain `tag` is a plain string envelope, NOT html-v3
    expect((node.settings['tag'] as TypedValue).$$type).toBe('string');
  });

  it('a link is the {destination:<url>,isTargetBlank,tag:string} envelope (UNION single-wrap)', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'btn',
        tag: 'a',
        target: widgetTarget('e-button'),
        settings_seed: {
          text: 'Go',
          link: { destination: 'https://t.co', isTargetBlank: true, tag: 'a' },
        },
      }),
    ];
    const res = await assembleTree(tree, context());
    const node = res.elements[0] as AtomicWidgetNode;
    const link = node.settings['link'] as TypedValue;
    expect(link.$$type).toBe('link');
    const v = link.value as { destination: TypedValue; isTargetBlank: TypedValue; tag: TypedValue };
    expect(v.destination.$$type).toBe('url'); // chosen UNION member, single-wrapped
    expect(v.destination.value).toBe('https://t.co');
    // `link` is an OBJECT prop, so each field is a wrapped envelope (universal $$type rule). Elementor's
    // link-prop-type.php:42 makes isTargetBlank a Boolean_Prop_Type field → {$$type:'boolean',value:bool}.
    // VERIFIED against the live dry-run validator: wrapped → valid; bare `true` → ATOMIC_SETTINGS_INVALID.
    expect(v.isTargetBlank.$$type).toBe('boolean');
    expect(v.isTargetBlank.value).toBe(true);
    expect(v.tag.$$type).toBe('string');
    expect(v.tag.value).toBe('a');
    // the button text is html-v3
    expect((node.settings['text'] as TypedValue).$$type).toBe('html-v3');
  });

  it('atomic widget version is 0.0; container editor_settings is [], widget is an object', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'a',
        tag: 'div',
        target: containerTarget('e-div-block', 'div'),
        children: [
          styled({
            source_path: 'a>h',
            tag: 'h2',
            target: widgetTarget('e-heading'),
            settings_seed: { tag: 'h2', title: 'Heading' },
          }),
        ],
      }),
    ];
    const res = await assembleTree(tree, context());
    const container = res.elements[0] as AtomicContainerNode;
    expect(container.version).toBe('0.0');
    expect(Array.isArray(container.editor_settings)).toBe(true);
    expect(container.interactions).toEqual([]);
    const widget = container.elements?.[0] as AtomicWidgetNode;
    expect(widget.version).toBe('0.0');
    expect(Array.isArray(widget.editor_settings)).toBe(false);
    expect((widget.editor_settings as { title?: string }).title).toBe('Heading');
  });
});

/* ─────────────────────────── tabs structural integrity (§4) ──────────────────────────────────── */

describe('assembleTree — tabs structural integrity (§4)', () => {
  function tabsTree(tabCount: number, contentCount: number): StyledNode[] {
    const tabs = Array.from({ length: tabCount }, (_, i) =>
      styled({ source_path: `t${String(i)}`, tag: 'div', target: containerTarget('e-tab') }),
    );
    const contents = Array.from({ length: contentCount }, (_, i) =>
      styled({
        source_path: `c${String(i)}`,
        tag: 'div',
        target: containerTarget('e-tab-content'),
      }),
    );
    return [
      styled({
        source_path: 'tabs',
        tag: 'div',
        target: containerTarget('e-tabs'),
        children: [
          styled({
            source_path: 'menu',
            tag: 'div',
            target: containerTarget('e-tabs-menu'),
            children: tabs,
          }),
          styled({
            source_path: 'area',
            tag: 'div',
            target: containerTarget('e-tabs-content-area'),
            children: contents,
          }),
        ],
      }),
    ];
  }

  it('matched tab/content counts assemble without error', async () => {
    const res = await assembleTree(tabsTree(3, 3), context());
    expect(res.elements[0]?.elType).toBe('e-tabs');
  });

  it('mismatched tab/content counts throw (counts MUST match)', async () => {
    await expect(assembleTree(tabsTree(3, 2), context())).rejects.toThrow(
      /e-tabs structural mismatch/,
    );
  });
});

/* ─────────────────────────── v3 classic fallback ─────────────────────────────────────────────── */

describe('assembleTree — v3 classic fallback (no styles map, flat settings)', () => {
  it('generation v3 produces flat ClassicNode settings (no typed envelopes, no styles map)', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'h',
        tag: 'h1',
        target: {
          ...widgetTarget('e-heading'),
          v3_fallback: { elType: 'widget', widgetType: 'heading' },
        },
        settings_seed: { tag: 'h1', title: 'Hello' },
        local_styles: [localStyle('color', { $$type: 'color', value: '#000' })],
      }),
    ];
    const res = await assembleTree(tree, context({ generation: 'v3' }));
    const node = res.elements[0] as ClassicNode;
    expect(node.elType).toBe('widget');
    expect(node.widgetType).toBe('heading');
    // flat raw settings — title is a raw string, not an html-v3 envelope
    expect(node.settings['title']).toBe('Hello');
    // no styles map / version siblings on classic nodes
    expect((node as { styles?: unknown }).styles).toBeUndefined();
    expect((node as { version?: unknown }).version).toBeUndefined();
  });
});

/* ─────────────────────────── CONTRACT: structural schema validation (Ajv2020) ────────────────── */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = resolve(HERE, '..', '..', '..', 'shared', 'schemas');

/** Compile a validator for element-node.schema.json (+ its cross-referenced schemas). */
function compileElementNodeValidator(): ValidateFunction {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const name of [
    'atomic-prop-types.schema.json',
    'style-variant.schema.json',
    'element-node.schema.json',
  ]) {
    const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, name), 'utf8')) as AnySchemaObject;
    ajv.addSchema(schema);
  }
  const fn = ajv.getSchema(
    'https://elementor-ultra-mcp/spec/contracts/schemas/element-node.schema.json',
  );
  if (fn === undefined) {
    throw new Error('element-node.schema.json validator did not compile');
  }
  return fn;
}

describe('assembleTree — produced nodes validate against element-node.schema.json (criterion: structural)', () => {
  const validate = compileElementNodeValidator();

  function validateTree(nodes: ElementNode[]): void {
    for (const node of nodes) {
      const ok = validate(node);
      expect(ok, JSON.stringify(validate.errors)).toBe(true);
      if (node.elements) validateTree(node.elements);
    }
  }

  it('a representative atomic tree (container + heading + image + button) is schema-valid', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'hero',
        tag: 'section',
        target: containerTarget('e-div-block', 'section'),
        local_styles: [localStyle('display', strEnvelope('flex'))],
        children: [
          styled({
            source_path: 'hero>h1',
            tag: 'h1',
            target: widgetTarget('e-heading'),
            settings_seed: { tag: 'h1', title: 'Big <b>Title</b>' },
            local_styles: [localStyle('color', { $$type: 'color', value: '#fff' })],
          }),
          styled({
            source_path: 'hero>img',
            tag: 'img',
            target: widgetTarget('e-image'),
            settings_seed: { image: { __media_pending: imgMedia('https://i/p.png', 'pic') } },
          }),
          styled({
            source_path: 'hero>btn',
            tag: 'a',
            target: widgetTarget('e-button'),
            settings_seed: {
              text: 'Click',
              link: { destination: 'https://x.io', isTargetBlank: false, tag: 'a' },
            },
          }),
        ],
      }),
    ];
    const res = await assembleTree(tree, context());
    validateTree(res.elements);
  });

  it('a v3 classic fallback tree is schema-valid', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'p',
        tag: 'p',
        target: {
          ...widgetTarget('e-paragraph'),
          v3_fallback: { elType: 'widget', widgetType: 'text-editor' },
        },
        settings_seed: { tag: 'p', paragraph: 'Body copy' },
      }),
    ];
    const res = await assembleTree(tree, context({ generation: 'v3' }));
    validateTree(res.elements);
  });
});

/* ─────────── leaf text widgets are ALWAYS leaves + no typeless widget (the render-500 fix) ─────── */

describe('assembleTree — leaf text widgets never carry children; no typeless widget', () => {
  /** Walk the tree, collecting every node so invariants can be asserted across the whole result. */
  function flatten(nodes: ElementNode[], acc: ElementNode[] = []): ElementNode[] {
    for (const n of nodes) {
      acc.push(n);
      if (n.elements) flatten(n.elements, acc);
    }
    return acc;
  }

  it('an e-heading with (stray) children is emitted as a LEAF (elements:[])', async () => {
    // Defensive backstop: even if a child reaches a leaf text widget (NORMALIZE should have folded it),
    // ASSEMBLE must NOT emit element children on a heading/paragraph/button (the frontend chokes).
    const tree: StyledNode[] = [
      styled({
        source_path: 'h1',
        tag: 'h1',
        target: widgetTarget('e-heading'),
        settings_seed: { tag: 'h1', title: 'Customer intelligence, <span>on autopilot</span>' },
        children: [
          styled({
            source_path: 'h1>span',
            tag: 'span',
            target: widgetTarget('e-paragraph'),
            settings_seed: { tag: 'span', paragraph: 'on autopilot' },
          }),
        ],
      }),
    ];
    const res = await assembleTree(tree, context());
    const heading = res.elements[0] as AtomicWidgetNode;
    expect(heading.widgetType).toBe('e-heading');
    expect(heading.elements).toEqual([]); // leaf — the stray child is dropped
    // No node anywhere is a typeless widget.
    for (const n of flatten(res.elements)) {
      if (n.elType === 'widget') {
        expect(typeof (n as AtomicWidgetNode).widgetType).toBe('string');
        expect((n as AtomicWidgetNode).widgetType).not.toBe('');
      }
    }
  });

  it('e-paragraph and e-button are also emitted as leaves', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'p',
        tag: 'p',
        target: widgetTarget('e-paragraph'),
        settings_seed: { tag: 'p', paragraph: 'x' },
        children: [styled({ source_path: 'p>em', tag: 'em', target: widgetTarget('e-paragraph') })],
      }),
      styled({
        source_path: 'b',
        tag: 'a',
        target: widgetTarget('e-button'),
        settings_seed: { text: 'Go' },
        children: [styled({ source_path: 'b>i', tag: 'i', target: widgetTarget('e-svg') })],
      }),
    ];
    const res = await assembleTree(tree, context());
    expect((res.elements[0] as AtomicWidgetNode).elements).toEqual([]);
    expect((res.elements[1] as AtomicWidgetNode).elements).toEqual([]);
  });

  it('a CONTAINER keeps its assembled children (the leaf forcing applies to atomic widgets only)', async () => {
    // Containers (e-div-block/e-flexbox/…) always keep their children; only atomic WIDGETS (every
    // type outside the child-bearing set, contract 17 I1) are forced leaves — no over-reach.
    const tree: StyledNode[] = [
      styled({
        source_path: 'fig',
        tag: 'div',
        target: containerTarget('e-div-block', 'div'),
        children: [styled({ source_path: 'fig>h2', tag: 'h2', target: widgetTarget('e-heading') })],
      }),
    ];
    const res = await assembleTree(tree, context());
    const container = res.elements[0] as AtomicContainerNode;
    expect(container.elements?.length).toBe(1); // container keeps its child heading
    expect((container.elements?.[0] as AtomicWidgetNode).elements).toEqual([]); // heading is a leaf
  });

  it('a classic-fallback widget with NO v3 widgetType falls back to text-editor (never typeless)', async () => {
    // A degenerate target: elType:'widget' but no resolvable widgetType. The V3 classic path must
    // still emit a widgetType (text-editor) so the frontend never fatals on a typeless widget.
    const tree: StyledNode[] = [
      styled({
        source_path: 'x',
        tag: 'p',
        target: {
          generation: 'v4',
          elType: 'widget', // not an `e-*` widget → isAtomicTarget false → classic path
          is_container: false,
          settings_seed: { paragraph: 'orphan' },
          v3_fallback: { elType: 'widget' }, // NO widgetType — the typeless trap
        },
        settings_seed: { paragraph: 'orphan' },
      }),
    ];
    const res = await assembleTree(tree, context());
    const w = res.elements[0] as ClassicNode;
    expect(w.elType).toBe('widget');
    expect(w.widgetType).toBe('text-editor'); // safe default, NOT undefined
  });
});

/* ─────────────── contract 17 I1 — reference closure (the page-1704 dangling-ref fix) ──────────── */

describe('assembleTree — reference closure (contract 17 I1, page-1704 dangling SVG wrapper styles)', () => {
  /**
   * The I1 closure check, duplicated LOCALLY (contract 17 W1 ships it in `convert/integrity.ts`;
   * these tests stay decoupled from that module on purpose): for every node, every id in
   * `settings.classes.value` must resolve to a definition in the node's `styles` map (direction one —
   * page 1704 broke this: 12 dangling refs → zero-size icons + CSS_PRIME_FAILED), and every
   * `styles`-map id must be referenced back (direction two — orphaned styles). At the ASSEMBLE seam
   * every classes entry is assemble-minted and local (HOIST swaps in `g-*` ids later).
   */
  function closureViolations(nodes: ElementNode[]): string[] {
    const violations: string[] = [];
    const walk = (ns: ElementNode[]): void => {
      for (const n of ns) {
        const settings = (n as { settings?: Record<string, unknown> }).settings;
        const classes = settings?.['classes'];
        const refs = isClassesValue(classes) ? classes.value : [];
        const styles = (n as { styles?: Record<string, StyleDefinition> }).styles ?? {};
        const defined = new Set(Object.keys(styles));
        for (const ref of refs) {
          if (!defined.has(ref)) violations.push(`dangling_ref:${n.id}:${ref}`);
        }
        const referenced = new Set(refs);
        for (const sid of defined) {
          if (!referenced.has(sid)) violations.push(`orphaned_style:${n.id}:${sid}`);
        }
        if (n.elements) walk(n.elements);
      }
    };
    walk(nodes);
    return violations;
  }

  /** Collect every style-definition id present anywhere in the emitted tree. */
  function treeStyleIds(nodes: ElementNode[], acc = new Set<string>()): Set<string> {
    for (const n of nodes) {
      const styles = (n as { styles?: Record<string, StyleDefinition> }).styles ?? {};
      for (const id of Object.keys(styles)) acc.add(id);
      if (n.elements) treeStyleIds(n.elements, acc);
    }
    return acc;
  }

  const INLINE_SVG = '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';

  /** The page-1704 shape: an e-svg whose SVG-wrapper divs (each with local styles) reached ASSEMBLE. */
  function svgInWrapperTree(): StyledNode[] {
    return [
      styled({
        source_path: 'card',
        tag: 'div',
        target: containerTarget('e-div-block', 'div'),
        local_styles: [localStyle('display', strEnvelope('flex'))],
        children: [
          styled({
            source_path: 'card>icon',
            tag: 'div',
            target: widgetTarget('e-svg'),
            settings_seed: { svg: { __media_pending: { kind: 'svg', url: INLINE_SVG } } },
            local_styles: [
              localStyle('width', { $$type: 'size', value: { size: 48, unit: 'px' } }),
            ],
            children: [
              // The wrapper divs MAP failed to absorb — on page 1704 these were emitted UNDER the
              // e-svg; PHP stripped their styles maps but kept their classes → 12 dangling refs.
              styled({
                source_path: 'card>icon>wrap',
                tag: 'div',
                target: containerTarget('e-div-block', 'div'),
                local_styles: [localStyle('display', strEnvelope('flex'))],
                children: [
                  styled({
                    source_path: 'card>icon>wrap>inner',
                    tag: 'div',
                    target: containerTarget('e-div-block', 'div'),
                    local_styles: [localStyle('display', strEnvelope('block'))],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ];
  }

  it('svg-in-wrapper: the e-svg is a LEAF and reference closure holds in both directions', async () => {
    const res = await assembleTree(svgInWrapperTree(), context());
    const card = res.elements[0] as AtomicContainerNode;
    const icon = card.elements?.[0] as AtomicWidgetNode;
    expect(icon.widgetType).toBe('e-svg');
    expect(icon.elements).toEqual([]); // the wrapper divs are dropped, never emitted under the leaf
    // The inline markup still uploads and lands as an svg-src envelope.
    expect((icon.settings['svg'] as TypedValue).$$type).toBe('svg-src');
    // I1: no dangling class refs, no orphaned styles — anywhere in the tree.
    expect(closureViolations(res.elements)).toEqual([]);
    // The e-svg keeps its OWN style (mirrored into classes).
    const iconStyleIds = Object.keys(icon.styles ?? {});
    expect(iconStyleIds.length).toBe(1);
    expect((icon.settings['classes'] as Classes).value).toEqual(iconStyleIds);
  });

  it('svg-in-wrapper: dropped wrapper style ids are PRUNED from local_style_ids (result-level closure)', async () => {
    const res = await assembleTree(svgInWrapperTree(), context());
    const inTree = treeStyleIds(res.elements);
    // Every reported local-style id exists in the tree, and vice versa — no orphan ids leak to
    // downstream consumers (HOIST fingerprints / the CSS primer's expected-selector set).
    expect(new Set(res.local_style_ids)).toEqual(inTree);
    expect(res.local_style_ids.length).toBe(2); // card + the e-svg's own — NOT the dropped wrappers'
  });

  it('an e-image with a stray styled child is a leaf and leaks no orphan style ids', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'img',
        tag: 'img',
        target: widgetTarget('e-image'),
        settings_seed: { image: { __media_pending: imgMedia('https://x/p.png') } },
        children: [
          styled({
            source_path: 'img>cap',
            tag: 'div',
            target: containerTarget('e-div-block', 'div'),
            local_styles: [localStyle('display', strEnvelope('block'))],
          }),
        ],
      }),
    ];
    const res = await assembleTree(tree, context());
    expect((res.elements[0] as AtomicWidgetNode).elements).toEqual([]);
    expect(closureViolations(res.elements)).toEqual([]);
    expect(new Set(res.local_style_ids)).toEqual(treeStyleIds(res.elements));
  });

  it('leaf TEXT widget child drops also prune local_style_ids (no orphan ids in the result)', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'h',
        tag: 'h1',
        target: widgetTarget('e-heading'),
        settings_seed: { tag: 'h1', title: 'Hi' },
        local_styles: [localStyle('color', { $$type: 'color', value: '#000' })],
        children: [
          styled({
            source_path: 'h>span',
            tag: 'span',
            target: containerTarget('e-div-block', 'span'),
            local_styles: [localStyle('color', { $$type: 'color', value: '#f00' })],
          }),
        ],
      }),
    ];
    const res = await assembleTree(tree, context());
    expect(closureViolations(res.elements)).toEqual([]);
    expect(res.local_style_ids.length).toBe(1); // the heading's own style only
    expect(new Set(res.local_style_ids)).toEqual(treeStyleIds(res.elements));
  });

  it('a FLAT classic widget child drop prunes the dropped atomic styles from local_style_ids', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'flat',
        tag: 'div',
        target: {
          generation: 'v4',
          elType: 'widget',
          widgetType: 'video', // classic flat widget → leaf
          is_container: false,
          settings_seed: {},
          v3_fallback: { elType: 'widget', widgetType: 'video' },
        },
        children: [
          styled({
            source_path: 'flat>p',
            tag: 'p',
            target: widgetTarget('e-paragraph'),
            settings_seed: { tag: 'p', paragraph: 'x' },
            local_styles: [localStyle('color', { $$type: 'color', value: '#111' })],
          }),
        ],
      }),
    ];
    const res = await assembleTree(tree, context());
    expect((res.elements[0] as ClassicNode).elements).toEqual([]);
    expect(res.local_style_ids).toEqual([]); // the dropped paragraph's style id is pruned
  });

  it('e-tab-content as a WIDGET keeps its children (the only child-bearing atomic widget)', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'panel',
        tag: 'div',
        target: widgetTarget('e-tab-content'),
        children: [
          styled({
            source_path: 'panel>p',
            tag: 'p',
            target: widgetTarget('e-paragraph'),
            settings_seed: { tag: 'p', paragraph: 'Panel body' },
            local_styles: [localStyle('color', { $$type: 'color', value: '#222' })],
          }),
        ],
      }),
    ];
    const res = await assembleTree(tree, context());
    const panel = res.elements[0] as AtomicWidgetNode;
    expect(panel.widgetType).toBe('e-tab-content');
    expect(panel.elements?.length).toBe(1); // NOT forced leaf
    expect(closureViolations(res.elements)).toEqual([]);
    expect(new Set(res.local_style_ids)).toEqual(treeStyleIds(res.elements));
  });

  it('the background-overlay style (minted on a style-less node) closes in both directions', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'hero',
        tag: 'section',
        target: containerTarget('e-div-block', 'section'),
        media: { kind: 'background', url: 'https://bg/x.jpg' },
        // NO local_styles — applyBackgroundOverlay must mint a fresh style AND mirror it.
      }),
    ];
    const res = await assembleTree(tree, context());
    expect(closureViolations(res.elements)).toEqual([]);
    const node = res.elements[0] as AtomicContainerNode;
    expect(Object.keys(node.styles ?? {}).length).toBe(1);
    expect(new Set(res.local_style_ids)).toEqual(treeStyleIds(res.elements));
  });

  it('a representative mixed tree (containers/text/image/svg/tabs) yields ZERO closure violations', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'page',
        tag: 'div',
        target: containerTarget('e-flexbox', 'div'),
        local_styles: [localStyle('display', strEnvelope('flex'))],
        children: [
          ...svgInWrapperTree(),
          styled({
            source_path: 'page>h1',
            tag: 'h1',
            target: widgetTarget('e-heading'),
            settings_seed: { tag: 'h1', title: 'T' },
            local_styles: [localStyle('color', { $$type: 'color', value: '#fff' })],
          }),
          styled({
            source_path: 'page>img',
            tag: 'img',
            target: widgetTarget('e-image'),
            settings_seed: { image: { __media_pending: imgMedia('https://i/q.png') } },
          }),
        ],
      }),
    ];
    const res = await assembleTree(tree, context());
    expect(closureViolations(res.elements)).toEqual([]);
    expect(new Set(res.local_style_ids)).toEqual(treeStyleIds(res.elements));
  });
});

/* ─────────────────────────── contract 16 §3 — tier-1 behavior trees through ASSEMBLE ──────────── */

describe('assembleTree — classic nested-accordion in a V4 document (contract 16 §3)', () => {
  /** The MAP-restructured accordion: nested-accordion widget + one classic container per item
   *  holding the recursively converted (atomic) content — the recon `classic_in_v4_verdict` shape. */
  function nestedAccordionTree(): StyledNode[] {
    const content = styled({
      source_path: 'acc/body/p',
      tag: 'p',
      target: widgetTarget('e-paragraph'),
      settings_seed: { paragraph: 'An answer.', tag: 'p' },
    });
    const itemContainer = styled({
      source_path: 'acc::accordion-item-1',
      tag: 'div',
      target: {
        generation: 'v4',
        elType: 'container',
        is_container: true,
        settings_seed: {},
        v3_fallback: { elType: 'container' },
      },
      settings_seed: { content_width: 'full' },
      children: [content],
    });
    return [
      styled({
        source_path: 'acc',
        tag: 'details',
        target: {
          generation: 'v4',
          elType: 'widget',
          widgetType: 'nested-accordion',
          is_container: false,
          settings_seed: {},
          v3_fallback: { elType: 'widget', widgetType: 'nested-accordion' },
        },
        settings_seed: { items: [{ _id: 'ab12cd3', item_title: 'What is it?' }] },
        children: [itemContainer],
      }),
    ];
  }

  it('the NESTED classic widget KEEPS its item-container children (not forced leaf)', async () => {
    const res = await assembleTree(nestedAccordionTree(), context());
    const widget = res.elements[0] as ClassicNode;
    expect(widget.elType).toBe('widget');
    expect(widget.widgetType).toBe('nested-accordion');
    expect(widget.elements).toHaveLength(1);
    const item = widget.elements?.[0] as ClassicNode;
    expect(item.elType).toBe('container');
    expect(item.settings['content_width']).toBe('full');
    // the item content is the normally-assembled ATOMIC subtree (text/style fidelity preserved)
    const para = item.elements?.[0] as AtomicWidgetNode;
    expect(para.elType).toBe('widget');
    expect(para.widgetType).toBe('e-paragraph');
  });

  it('the items repeater passes through RAW on the classic path (no typed envelopes)', async () => {
    const res = await assembleTree(nestedAccordionTree(), context());
    const widget = res.elements[0] as ClassicNode;
    expect(widget.settings['items']).toEqual([{ _id: 'ab12cd3', item_title: 'What is it?' }]);
  });

  it('a FLAT classic widget still drops its children (only nested widgets keep them)', async () => {
    const tree: StyledNode[] = [
      styled({
        source_path: 'flat',
        tag: 'div',
        target: {
          generation: 'v4',
          elType: 'widget',
          widgetType: 'video', // classic flat widget (not nested-*)
          is_container: false,
          settings_seed: {},
          v3_fallback: { elType: 'widget', widgetType: 'video' },
        },
        children: [
          styled({ source_path: 'flat/x', tag: 'p', target: widgetTarget('e-paragraph') }),
        ],
      }),
    ];
    const res = await assembleTree(tree, context());
    const w = res.elements[0] as ClassicNode;
    expect(w.widgetType).toBe('video');
    expect(w.elements).toEqual([]);
  });
});

describe('assembleTree — restructured e-tabs family settings (contract 16 §3)', () => {
  it('default-active-tab wraps as a number envelope on the e-tabs container (recon shape)', async () => {
    const tab = styled({
      source_path: 't/list/t1',
      tag: 'button',
      target: containerTarget('e-tab'),
      children: [
        styled({
          source_path: 't/list/t1::label',
          tag: 'span',
          target: widgetTarget('e-paragraph'),
          settings_seed: { paragraph: 'Tab one', tag: 'span' },
        }),
      ],
    });
    const content = styled({
      source_path: 't/p1',
      tag: 'div',
      target: containerTarget('e-tab-content'),
    });
    const tree: StyledNode[] = [
      styled({
        source_path: 't',
        tag: 'div',
        target: containerTarget('e-tabs'),
        settings_seed: { 'default-active-tab': 1 },
        children: [
          styled({
            source_path: 't/list',
            tag: 'div',
            target: containerTarget('e-tabs-menu'),
            children: [tab],
          }),
          styled({
            source_path: 't::e-tabs-content-area',
            tag: 'div',
            target: containerTarget('e-tabs-content-area'),
            children: [content],
          }),
        ],
      }),
    ];
    const res = await assembleTree(tree, context());
    const tabs = res.elements[0] as AtomicContainerNode;
    expect(tabs.elType).toBe('e-tabs');
    expect(tabs.settings['default-active-tab']).toEqual({ $$type: 'number', value: 1 });
    // every family member carries the mandatory classes envelope
    const walkNodes = (n: ElementNode): void => {
      if (isAtomicContainerNode(n) || isAtomicWidgetNode(n)) {
        expect(isClassesValue(n.settings['classes'])).toBe(true);
      }
      for (const c of n.elements ?? []) walkNodes(c);
    };
    walkNodes(tabs);
    // and the tab label rides as html-v3 inside the e-tab (recon: label = e-paragraph tag span)
    const menu = tabs.elements?.[0] as AtomicContainerNode;
    const eTab = menu.elements?.[0] as AtomicContainerNode;
    const label = eTab.elements?.[0] as AtomicWidgetNode;
    expect(label.widgetType).toBe('e-paragraph');
    expect(label.settings['paragraph']).toEqual({
      $$type: 'html-v3',
      value: { content: { $$type: 'string', value: 'Tab one' }, children: [] },
    });
  });
});
