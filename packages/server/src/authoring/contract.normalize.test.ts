/**
 * WP-Q05 — Unit tests for the WP-F03 round-trip normalizer (`normalize()` exported by `./contract.ts`).
 *
 * `normalize()` is OWNED by WP-F03; this suite TESTS it (it does not modify or re-implement it — no
 * `normalize.ts` module is created). It asserts the round-trip tolerances `14-fixtures-harness.md §7`
 * demands so a `build → read → normalize` comparison shows zero spurious diffs:
 *   1. idempotence — `normalize(normalize(x))` deep-equals `normalize(x)`.
 *   2. `_cssid` tolerance — the auto-injected `_cssid` (`has-atomic-base.php:310-321`, RESEARCH §4.1)
 *      is stripped so a pre-save tree and a post-read tree compare equal.
 *   3. empty-sibling-key tolerance — empty `styles`/`editor_settings`/`interactions`/`elements` are
 *      dropped (so `{styles:{}}` == absent), while a NON-empty `elements` array is preserved + recursed.
 *   4. html-v3 normalization — the html-v3 envelope's text content survives unchanged (kses is PHP's job).
 *   5. id preservation — `normalize()` PRESERVES ids; literal-id comparison is NOT how round-trip
 *      identity is asserted. The structural-id helper below remaps minted ids positionally (spike
 *      C2/R5: element ids AND local-style ids are re-minted on save) while leaving stable global-class
 *      ids (`g-*`) untouched — that is the comparison the round-trip suite uses.
 */

import { describe, expect, it } from 'vitest';

import { normalize } from './contract.js';
import type { ElementNode } from './contract.js';

/* ───────────────────────────── structural-id comparison helper (C2/R5) ───────────────────── */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First element of a non-empty array, typed as defined (the fixtures are single-rooted). */
function first<T>(arr: readonly T[]): T {
  const v = arr[0];
  if (v === undefined) {
    throw new Error('expected a non-empty array');
  }
  return v;
}

/** Global-class ids (`g-*`) are stable external refs and are NEVER remapped (C2). */
function isStableId(id: string): boolean {
  return id.startsWith('g-');
}

/** Collect every minted id (node `id` + `styles` keys) in deterministic pre-order. */
function collectMintedIds(tree: ElementNode[]): string[] {
  const ids: string[] = [];
  const visit = (nodes: ElementNode[]): void => {
    for (const node of nodes) {
      if (typeof node.id === 'string') {
        ids.push(node.id);
      }
      const styles = (node as { styles?: Record<string, unknown> }).styles;
      if (isPlainObject(styles)) {
        for (const styleId of Object.keys(styles)) {
          ids.push(styleId);
        }
      }
      const children = (node as { elements?: ElementNode[] }).elements;
      if (Array.isArray(children) && children.length > 0) {
        visit(children);
      }
    }
  };
  visit(tree);
  return ids;
}

/**
 * Rewrite minted ids (node ids, `styles` keys, `StyleDefinition.id`, and local-style entries inside a
 * `classes` envelope value) to positional placeholders `#0,#1,…` so two structurally-identical trees
 * compare equal regardless of the re-minted id strings. Global-class ids are preserved.
 */
function canonicalizeIds(tree: ElementNode[]): ElementNode[] {
  const map = new Map<string, string>();
  let i = 0;
  for (const id of collectMintedIds(tree)) {
    if (!isStableId(id) && !map.has(id)) {
      map.set(id, `#${i}`);
      i += 1;
    }
  }
  const rename = (id: unknown): unknown =>
    typeof id === 'string' && map.has(id) ? map.get(id) : id;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map((item) => walk(item));
    }
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value)) {
        if (key === 'styles' && isPlainObject(v)) {
          const rekeyed: Record<string, unknown> = {};
          for (const [styleId, def] of Object.entries(v)) {
            rekeyed[rename(styleId) as string] = walk(def);
          }
          out[key] = rekeyed;
        } else if (key === 'id') {
          out[key] = rename(v);
        } else if (key === 'value' && Array.isArray(v)) {
          out[key] = v.map((entry) => rename(entry));
        } else {
          out[key] = walk(v);
        }
      }
      return out;
    }
    return value;
  };
  return walk(tree) as ElementNode[];
}

/** True iff two trees are structurally identical (normalized + id-canonicalized deep-equal). */
function structurallyEqual(a: ElementNode[], b: ElementNode[]): boolean {
  return (
    JSON.stringify(canonicalizeIds(normalize(a))) === JSON.stringify(canonicalizeIds(normalize(b)))
  );
}

/* ───────────────────────────── fixtures-in-code ──────────────────────────────────────────── */

const heading = (): ElementNode[] => [
  {
    id: 'hd00001',
    elType: 'widget',
    widgetType: 'e-heading',
    settings: {
      classes: { $$type: 'classes', value: [] },
      tag: { $$type: 'string', value: 'h2' },
      title: {
        $$type: 'html-v3',
        value: {
          content: { $$type: 'string', value: 'Hello' },
          children: [],
        },
      },
    },
    styles: {},
    editor_settings: [],
    interactions: [],
    elements: [],
  } as unknown as ElementNode,
];

/* ───────────────────────────── tests ─────────────────────────────────────────────────────── */

describe('normalize() — round-trip tolerances (§7)', () => {
  it('1) is idempotent: normalize(normalize(x)) equals normalize(x)', () => {
    const x = heading();
    const once = normalize(x);
    const twice = normalize(once);
    expect(twice).toEqual(once);
  });

  it('1b) does not mutate its input', () => {
    const x = heading();
    const snapshot = JSON.parse(JSON.stringify(x)) as ElementNode[];
    normalize(x);
    expect(x).toEqual(snapshot);
  });

  it('2) tolerates _cssid injection (stripped from settings)', () => {
    const authored = heading();
    const withCssid = JSON.parse(JSON.stringify(authored)) as ElementNode[];
    (first(withCssid) as unknown as { settings: Record<string, unknown> }).settings['_cssid'] =
      'e-abc1234';
    // A pre-save tree and a post-read tree (which has the injected _cssid) normalize equal.
    expect(normalize(withCssid)).toEqual(normalize(authored));
    // and the _cssid is gone from the normalized output.
    const out = first(normalize(withCssid)) as unknown as { settings: Record<string, unknown> };
    expect('_cssid' in out.settings).toBe(false);
  });

  it('3) drops empty sibling keys (styles/editor_settings/interactions/elements)', () => {
    const out = first(normalize(heading())) as unknown as Record<string, unknown>;
    expect('styles' in out).toBe(false);
    expect('editor_settings' in out).toBe(false);
    expect('interactions' in out).toBe(false);
    expect('elements' in out).toBe(false);
  });

  it('3b) {styles:{}} normalizes equal to an absent styles key', () => {
    const withEmpty = heading();
    const withoutKey = JSON.parse(JSON.stringify(heading())) as Array<Record<string, unknown>>;
    const node = first(withoutKey);
    delete node['styles'];
    delete node['editor_settings'];
    delete node['interactions'];
    delete node['elements'];
    expect(normalize(withEmpty)).toEqual(normalize(withoutKey as unknown as ElementNode[]));
  });

  it('3c) preserves + recurses into a NON-empty elements array', () => {
    const tree: ElementNode[] = [
      {
        id: 'con0001',
        elType: 'e-div-block',
        settings: { classes: { $$type: 'classes', value: [] } },
        styles: {},
        editor_settings: [],
        interactions: [],
        elements: heading(),
      } as unknown as ElementNode,
    ];
    const out = first(normalize(tree)) as unknown as { elements?: unknown[] };
    expect(Array.isArray(out.elements)).toBe(true);
    expect(out.elements).toHaveLength(1);
    // The child was itself normalized (its empty sibling keys dropped).
    const child = first(out.elements as Array<Record<string, unknown>>);
    expect('styles' in child).toBe(false);
  });

  it('4) preserves html-v3 text content unchanged (kses is PHP-side, not re-run)', () => {
    const out = first(normalize(heading())) as unknown as {
      settings: { title: { value: { content: { value: string } } } };
    };
    expect(out.settings.title.value.content.value).toBe('Hello');
  });

  it('5) preserves ids literally (round-trip identity is asserted STRUCTURALLY, not by literal id)', () => {
    const out = first(normalize(heading())) as unknown as { id: string };
    expect(out.id).toBe('hd00001');
  });
});

describe('structural-id helper — positional remap (C2/R5)', () => {
  it('two trees differing only in minted ids are structurally equal', () => {
    const a = heading();
    const b = JSON.parse(JSON.stringify(heading())) as Array<Record<string, unknown>>;
    first(b)['id'] = 'zz99999'; // element id re-minted on save
    expect(structurallyEqual(a, b as unknown as ElementNode[])).toBe(true);
  });

  it('remaps a re-minted LOCAL-STYLE id (styles key + StyleDefinition.id + classes entry) (R5)', () => {
    const withStyle = (styleId: string): ElementNode[] => [
      {
        id: 'hd00001',
        elType: 'widget',
        widgetType: 'e-heading',
        settings: {
          classes: { $$type: 'classes', value: [styleId, 'g-keep'] },
          tag: { $$type: 'string', value: 'h2' },
        },
        styles: {
          [styleId]: {
            id: styleId,
            type: 'class',
            label: 'local',
            variants: [
              {
                meta: { breakpoint: 'desktop', state: null },
                props: { color: { $$type: 'color', value: 'rgb(0,0,0)' } },
              },
            ],
          },
        },
      } as unknown as ElementNode,
    ];
    // Same structure, the local-style id re-minted on save; the GLOBAL-class id (g-keep) is stable.
    expect(structurallyEqual(withStyle('e-hd00001-7f3a9c2'), withStyle('e-zz99999-aaaaaaa'))).toBe(
      true,
    );
  });

  it('a re-minted GLOBAL-class id IS a real difference (g-* is stable, never remapped)', () => {
    const withGlobal = (g: string): ElementNode[] => [
      {
        id: 'hd00001',
        elType: 'widget',
        widgetType: 'e-heading',
        settings: { classes: { $$type: 'classes', value: [g] } },
      } as unknown as ElementNode,
    ];
    expect(structurallyEqual(withGlobal('g-one'), withGlobal('g-two'))).toBe(false);
  });

  it('a dropped settings prop is NOT structurally equal (catches a spurious diff)', () => {
    const a = heading();
    const b = JSON.parse(JSON.stringify(heading())) as Array<{ settings: Record<string, unknown> }>;
    delete first(b).settings['tag'];
    expect(structurallyEqual(a, b as unknown as ElementNode[])).toBe(false);
  });

  it('a changed text value is NOT structurally equal', () => {
    const a = heading();
    const b = JSON.parse(JSON.stringify(heading())) as Array<{
      settings: { title: { value: { content: { value: string } } } };
    }>;
    first(b).settings.title.value.content.value = 'Changed';
    expect(structurallyEqual(a, b as unknown as ElementNode[])).toBe(false);
  });
});
