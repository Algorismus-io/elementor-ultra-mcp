/**
 * WP-H10 — accessibility LINT unit tests.
 *
 * Each rule (heading hierarchy: multiple-h1 blocker + skipped-level warning; empty interactive name;
 * missing image alt) is exercised on crafted ASSEMBLED `ElementNode[]` with typed-envelope settings.
 */

import { describe, expect, it } from 'vitest';

import type { AtomicContainerNode, AtomicWidgetNode, TypedValue } from '../authoring/contract.js';
import {
  classesValue,
  htmlV3,
  imageSrcById,
  imageSrcByUrl,
  typedValue,
} from '../authoring/envelopes.js';
import { lintA11y } from './a11y.js';

/* ─────────────────────────── node builders ───────────────────────────────────────────────────── */

function heading(id: string, tag: string, title?: string): AtomicWidgetNode {
  const settings: Record<string, TypedValue> = {
    classes: classesValue([]),
    tag: typedValue('string', tag),
  };
  if (title !== undefined) settings['title'] = htmlV3(title);
  return { id, elType: 'widget', widgetType: 'e-heading', settings };
}

function button(id: string, text?: string, extra?: Record<string, TypedValue>): AtomicWidgetNode {
  const settings: Record<string, TypedValue> = { classes: classesValue([]), ...extra };
  if (text !== undefined) settings['text'] = htmlV3(text);
  return { id, elType: 'widget', widgetType: 'e-button', settings };
}

function image(id: string, alt?: string): AtomicWidgetNode {
  const src =
    alt !== undefined && alt !== ''
      ? imageSrcById(typedValue('image-attachment-id', 100), typedValue('string', alt))
      : imageSrcById(typedValue('image-attachment-id', 100));
  return {
    id,
    elType: 'widget',
    widgetType: 'e-image',
    settings: {
      classes: classesValue([]),
      image: { $$type: 'image', value: { src, size: typedValue('string', 'full') } },
    },
  };
}

function container(
  id: string,
  children: (AtomicWidgetNode | AtomicContainerNode)[],
): AtomicContainerNode {
  return {
    id,
    elType: 'e-div-block',
    settings: { classes: classesValue([]) },
    elements: children,
  };
}

/* ─────────────────────────── heading hierarchy ───────────────────────────────────────────────── */

describe('lintA11y: heading hierarchy', () => {
  it('a clean single-h1 + sequential levels yields no findings', () => {
    const tree = [container('root', [heading('h1', 'h1', 'Title'), heading('h2', 'h2', 'Sub')])];
    expect(lintA11y(tree)).toEqual([]);
  });

  it('multiple h1 → a blocker on each EXTRA h1 (first is canonical)', () => {
    const tree = [container('root', [heading('h1a', 'h1', 'One'), heading('h1b', 'h1', 'Two')])];
    const findings = lintA11y(tree);
    const blockers = findings.filter(
      (f) => f.rule === 'heading-hierarchy' && f.severity === 'blocker',
    );
    expect(blockers.length).toBe(1);
    expect(blockers[0]?.element_id).toBe('h1b'); // the SECOND h1
  });

  it('multiple-h1 severity is configurable to warning', () => {
    const tree = [container('root', [heading('a', 'h1'), heading('b', 'h1')])];
    const findings = lintA11y(tree, { multiple_h1_severity: 'warning' });
    expect(findings.find((f) => f.rule === 'heading-hierarchy')?.severity).toBe('warning');
  });

  it('a skipped level (h2 → h4) → exactly one warning on the deeper heading', () => {
    const tree = [
      container('root', [
        heading('sec', 'h2', 'Section'),
        heading('card', 'h4', 'Card'), // skips h3
      ]),
    ];
    const findings = lintA11y(tree);
    const skipped = findings.filter(
      (f) => f.rule === 'heading-hierarchy' && f.severity === 'warning',
    );
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.element_id).toBe('card');
    expect(skipped[0]?.message).toContain('h3');
  });

  it('returning to a shallower level then advancing one step does NOT warn', () => {
    const tree = [
      container('root', [
        heading('a', 'h1'),
        heading('b', 'h2'),
        heading('c', 'h2'),
        heading('d', 'h3'), // one step deeper than the prior h2 — OK
      ]),
    ];
    expect(lintA11y(tree).filter((f) => f.rule === 'heading-hierarchy')).toEqual([]);
  });
});

/* ─────────────────────────── empty interactive name ──────────────────────────────────────────── */

describe('lintA11y: empty interactive name', () => {
  it('a button with text has no finding', () => {
    expect(lintA11y([button('b', 'Get started')])).toEqual([]);
  });

  it('a button with empty text → a warning', () => {
    const findings = lintA11y([button('b', '')]);
    expect(findings.length).toBe(1);
    expect(findings[0]?.rule).toBe('empty-interactive-name');
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.element_id).toBe('b');
  });

  it('a button with no text setting at all → a warning', () => {
    const findings = lintA11y([button('b')]);
    expect(findings[0]?.rule).toBe('empty-interactive-name');
  });

  it('an aria-label rescues a text-less button (no finding)', () => {
    const findings = lintA11y([
      button('b', undefined, { 'aria-label': typedValue('string', 'Close') }),
    ]);
    expect(findings.filter((f) => f.rule === 'empty-interactive-name')).toEqual([]);
  });

  it('a link container with a link setting but no text → a warning (icon-only link)', () => {
    const iconLink: AtomicContainerNode = {
      id: 'icon',
      elType: 'e-div-block',
      settings: {
        classes: classesValue([]),
        link: { $$type: 'link', value: { destination: typedValue('url', 'https://x/') } },
      },
    };
    const findings = lintA11y([iconLink]);
    expect(findings.find((f) => f.rule === 'empty-interactive-name')?.element_id).toBe('icon');
  });

  it('empty-interactive severity is configurable to blocker', () => {
    const findings = lintA11y([button('b', '')], { empty_interactive_severity: 'blocker' });
    expect(findings[0]?.severity).toBe('blocker');
  });
});

/* ─────────────────────────── missing alt ─────────────────────────────────────────────────────── */

describe('lintA11y: missing image alt', () => {
  it('an image with alt has no finding', () => {
    expect(lintA11y([image('img', 'A logo')])).toEqual([]);
  });

  it('an image with no alt → a warning', () => {
    const findings = lintA11y([image('img')]);
    expect(findings.length).toBe(1);
    expect(findings[0]?.rule).toBe('missing-alt');
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.element_id).toBe('img');
  });

  it('a url-only image with no alt also warns', () => {
    const node: AtomicWidgetNode = {
      id: 'ext',
      elType: 'widget',
      widgetType: 'e-image',
      settings: {
        classes: classesValue([]),
        image: {
          $$type: 'image',
          value: {
            src: imageSrcByUrl(typedValue('url', 'https://x/y.png')),
            size: typedValue('string', 'full'),
          },
        },
      },
    };
    expect(lintA11y([node]).find((f) => f.rule === 'missing-alt')?.element_id).toBe('ext');
  });
});

/* ─────────────────────────── nested walk + combined ──────────────────────────────────────────── */

describe('lintA11y: nested document-order walk', () => {
  it('finds violations deep in the tree and reports them by minted id', () => {
    const tree = [
      container('root', [
        heading('h1', 'h1', 'Hero'),
        container('cards', [
          heading('cardTitle', 'h4', 'Card'), // skipped level h1 → h4? prev heading is h1 → warning
          button('cta', ''), // empty name
          image('thumb'), // missing alt
        ]),
      ]),
    ];
    const findings = lintA11y(tree);
    const rules = findings.map((f) => f.rule).sort();
    expect(rules).toContain('empty-interactive-name');
    expect(rules).toContain('missing-alt');
    expect(rules).toContain('heading-hierarchy');
  });
});
