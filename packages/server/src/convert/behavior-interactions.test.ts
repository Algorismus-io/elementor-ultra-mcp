/**
 * Contract 16 §4 — Tier 2 NATIVE INTERACTIONS emitter unit tests.
 *
 * Covers: EXACT S08 frozen-shape emission (byte-level `$$type` keys `interaction-item` /
 * `animation-preset-props` / `timing-config` / `config-v2` / `size`; `interaction_id` omitted);
 * the §4 mapping table (opacity→fade, translate→slide+direction, scale→scale; duration clamp
 * ≥100ms / default 600ms; scrollIn vs load); S08 Pro gating (hover trigger, easings beyond
 * easeIn); the 5-per-element Validation cap; honest tier-4 reasons for everything
 * non-expressible; §8 invariants 1 (count(candidates)==count(report), tier always set) and 5
 * (zero behaviors → byte-identical passthrough); and `postSaveAssert` sanitizer-drop detection
 * (§8 invariant 2). PURE — tiny fixtures, no Playwright, no WP client.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DURATION_MS,
  MAX_INTERACTIONS_PER_ELEMENT,
  MIN_DURATION_MS,
  buildInteractionItem,
  collectInteractionBearingIds,
  decodeInteractionItems,
  diagnoseInteractionWiring,
  emitInteractions,
  postSaveAssert,
  type AuthoredInteractions,
  type InteractionsContext,
} from './behavior-interactions.js';
import type {
  AtomicContainerNode,
  AtomicWidgetNode,
  ClassicNode,
  ElementNode,
} from '../authoring/contract.js';
import type {
  AnimationProbe,
  DetectedBehavior,
  IrNode,
  SiteCapabilities,
  TransitionProbe,
} from './types.js';

/* ─────────────────────────── fixtures ────────────────────────────────────────────────────────── */

/** A maximal-capability site (mirrors `map.test.ts` `caps`). */
function caps(overrides: Partial<SiteCapabilities> = {}): SiteCapabilities {
  return {
    v4: true,
    atomic: true,
    global_classes: true,
    variables: true,
    pro: true,
    pro_atomic_form: true,
    breakpoints: [],
    experiments: {},
    can_update_class: true,
    classes_migrated: true,
    registered_types: { atomic: [], classic: [] },
    versions: { elementor: '4.1.1', pro: '4.1.0', plugin: '0.1.0' },
    unfiltered_html: true,
    ...overrides,
  };
}

function ctx(overrides: Partial<InteractionsContext> = {}): InteractionsContext {
  return {
    capabilities: caps(),
    id_map: { 'body>div': 'abc1234' },
    ...overrides,
  };
}

/** A minimal IR node (defaults mirror the classify/map test builders). */
function irNode(partial: Partial<IrNode> = {}): IrNode {
  return {
    source_path: 'body>div',
    tag: 'div',
    role: 'structural-block',
    box: { x: 0, y: 0, width: 800, height: 200 },
    computed: {},
    responsive: {},
    attrs: {},
    textRuns: [],
    children: [],
    ...partial,
  };
}

function behavior(
  kind: DetectedBehavior['kind'],
  nodeId = 'body>div',
  partial: Partial<DetectedBehavior> = {},
): DetectedBehavior {
  return {
    kind,
    confidence: 'high',
    evidence: ['keyframes:probe'],
    nodeIds: [nodeId],
    ...partial,
  };
}

/** An entrance-animation IR node carrying a keyframes probe (the high-confidence path). */
function entranceNode(probe: Partial<AnimationProbe>, partial: Partial<IrNode> = {}): IrNode {
  const animationProbe: AnimationProbe = {
    name: 'probe',
    duration: '0.8s',
    delay: '0s',
    easing: 'ease-in',
    keyframeProps: ['opacity'],
    ...probe,
  };
  const node = irNode({ animationProbe, ...partial });
  node.behaviors = [behavior('entrance-animation', node.source_path)];
  return node;
}

/** A hover-effect IR node (forced-`:hover` delta + transition probe). */
function hoverNode(
  hoverComputed: Record<string, string>,
  probe: Partial<TransitionProbe> = {},
  partial: Partial<IrNode> = {},
): IrNode {
  const transitionProbe: TransitionProbe = {
    property: 'all',
    duration: '0.3s',
    easing: 'ease-in',
    ...probe,
  };
  const node = irNode({ hoverComputed, transitionProbe, ...partial });
  node.behaviors = [
    behavior('hover-effect', node.source_path, {
      evidence: [`hover-delta:${Object.keys(hoverComputed).join(',')}`],
    }),
  ];
  return node;
}

/** A minimal atomic widget element. */
function widgetEl(id: string): AtomicWidgetNode {
  return {
    id,
    elType: 'widget',
    widgetType: 'e-heading',
    settings: { classes: { $$type: 'classes', value: [] } },
    styles: {},
    editor_settings: [],
    interactions: [],
    elements: [],
  };
}

/** A minimal atomic container wrapping children. */
function containerEl(id: string, children: ElementNode[] = []): AtomicContainerNode {
  return {
    id,
    elType: 'e-div-block',
    settings: { classes: { $$type: 'classes', value: [] } },
    styles: {},
    editor_settings: [],
    interactions: [],
    elements: children,
  };
}

/** A V3 classic node (interactions are atomic-only). */
function classicEl(id: string): ClassicNode {
  return { id, elType: 'widget', widgetType: 'html', settings: {}, elements: [] };
}

/** Decode the (string) interactions blob off an element. */
function blobOf(el: ElementNode): { version: number; items: unknown[] } {
  const raw = (el as { interactions?: unknown }).interactions;
  expect(typeof raw).toBe('string'); // the native wire format is a JSON string (S08)
  return JSON.parse(raw as string) as { version: number; items: unknown[] };
}

function firstItem(el: ElementNode): Record<string, unknown> {
  return blobOf(el).items[0] as Record<string, unknown>;
}

/* ─────────────────────────── exact S08 frozen shape ──────────────────────────────────────────── */

describe('S08 frozen shape', () => {
  it('emits the EXACT spike-S08 doc shape for a load fade-in (byte-level $$type keys)', () => {
    const node = entranceNode({
      duration: '0.8s',
      delay: '0s',
      easing: 'ease-in',
      keyframeProps: ['opacity'],
      opacity: { from: 0, to: 1 },
    });
    const res = emitInteractions([widgetEl('abc1234')], [node], ctx());

    const el = res.elements[0] as ElementNode;
    expect(blobOf(el)).toEqual({
      version: 1,
      items: [
        {
          $$type: 'interaction-item',
          value: {
            trigger: { $$type: 'string', value: 'load' },
            animation: {
              $$type: 'animation-preset-props',
              value: {
                effect: { $$type: 'string', value: 'fade' },
                type: { $$type: 'string', value: 'in' },
                direction: { $$type: 'string', value: '' },
                timing_config: {
                  $$type: 'timing-config',
                  value: {
                    duration: { $$type: 'size', value: { unit: 'ms', size: 800 } },
                    delay: { $$type: 'size', value: { unit: 'ms', size: 0 } },
                  },
                },
                config: {
                  $$type: 'config-v2',
                  value: { easing: { $$type: 'string', value: 'easeIn' } },
                },
              },
            },
          },
        },
      ],
    });
    expect(res.report).toHaveLength(1);
    expect(res.report[0]?.tier).toBe(2);
    expect(res.authored).toEqual([
      { element_id: 'abc1234', source_path: 'body>div', items: 1 },
    ]);
  });

  it('never emits the sanitizer-dropped key spellings (interaction_id / animation-config / time-size)', () => {
    const node = entranceNode({ opacity: { from: 0, to: 1 } });
    const res = emitInteractions([widgetEl('abc1234')], [node], ctx());
    const raw = (res.elements[0] as { interactions?: unknown }).interactions as string;
    expect(raw).not.toContain('interaction_id');
    expect(raw).not.toContain('animation-config');
    expect(raw).not.toContain('time-size');
    expect(raw).toContain('"config-v2"');
    expect(raw).toContain('"timing-config"');
    expect(raw).toContain('"size"');
  });

  it('matches the frozen-shape snapshot', () => {
    const node = entranceNode({
      duration: '0.8s',
      delay: '0.2s',
      easing: 'ease-in',
      keyframeProps: ['opacity', 'transform'],
      opacity: { from: 0, to: 1 },
      transform: { from: 'translateY(40px)', to: 'none' },
    });
    const res = emitInteractions([widgetEl('abc1234')], [node], ctx());
    expect(blobOf(res.elements[0] as ElementNode)).toMatchSnapshot();
  });

  it('buildInteractionItem omits config when easing is null (config block is OPTIONAL)', () => {
    const item = buildInteractionItem({
      trigger: 'load',
      effect: 'fade',
      type: 'in',
      direction: '',
      durationMs: 600,
      delayMs: 0,
      easing: null,
    });
    expect(item.value.animation.value.config).toBeUndefined();
    expect(Object.keys(item.value.animation.value)).toEqual([
      'effect',
      'type',
      'direction',
      'timing_config',
    ]);
  });
});

/* ─────────────────────────── §4 effect mapping ───────────────────────────────────────────────── */

describe('effect mapping (§4)', () => {
  function emittedAnimation(node: IrNode): Record<string, { value: unknown }> {
    const res = emitInteractions([widgetEl('abc1234')], [node], ctx());
    expect(res.report[0]?.tier).toBe(2);
    const item = firstItem(res.elements[0] as ElementNode) as {
      value: { animation: { value: Record<string, { value: unknown }> } };
    };
    return item.value.animation.value;
  }

  it('opacity-only keyframes → fade in', () => {
    const anim = emittedAnimation(entranceNode({ opacity: { from: 0, to: 1 } }));
    expect(anim['effect']?.value).toBe('fade');
    expect(anim['type']?.value).toBe('in');
    expect(anim['direction']?.value).toBe('');
  });

  it('opacity 1→0 keyframes → fade out', () => {
    const anim = emittedAnimation(entranceNode({ opacity: { from: 1, to: 0 } }));
    expect(anim['effect']?.value).toBe('fade');
    expect(anim['type']?.value).toBe('out');
  });

  it.each([
    ['translateY(40px)', 'bottom'], // comes up from below
    ['translateY(-40px)', 'top'],
    ['translateX(-60px)', 'left'],
    ['translateX(60px)', 'right'],
    ['translate(-80px, 10px)', 'left'], // dominant axis wins
    ['translate3d(0, 120px, 0)', 'bottom'],
  ])('translate keyframes %s → slide from %s', (from, direction) => {
    const anim = emittedAnimation(
      entranceNode({
        keyframeProps: ['opacity', 'transform'],
        opacity: { from: 0, to: 1 },
        transform: { from, to: 'none' },
      }),
    );
    expect(anim['effect']?.value).toBe('slide');
    expect(anim['direction']?.value).toBe(direction);
    expect(anim['type']?.value).toBe('in');
  });

  it('exit keyframes ending offset (none → translateY(40px), moves DOWN) → slide out toward bottom', () => {
    // Runtime semantics: an `out` direction is the side moved TOWARD (out+bottom → y:[0,+d]),
    // the opposite of the `in` "comes from" side — the sign flips for out slides.
    const anim = emittedAnimation(
      entranceNode({
        keyframeProps: ['transform'],
        transform: { from: 'none', to: 'translateY(40px)' },
      }),
    );
    expect(anim['effect']?.value).toBe('slide');
    expect(anim['type']?.value).toBe('out');
    expect(anim['direction']?.value).toBe('bottom');
  });

  it('percentage translates resolve against the node box (translateY(-100%) on a 200px box → top)', () => {
    const anim = emittedAnimation(
      entranceNode({
        keyframeProps: ['transform'],
        transform: { from: 'translateY(-100%)', to: 'none' },
      }),
    );
    expect(anim['effect']?.value).toBe('slide');
    expect(anim['direction']?.value).toBe('top');
  });

  it('scale keyframes → scale in (no translation present)', () => {
    const anim = emittedAnimation(
      entranceNode({
        keyframeProps: ['opacity', 'transform'],
        opacity: { from: 0, to: 1 },
        transform: { from: 'scale(0.8)', to: 'none' },
      }),
    );
    expect(anim['effect']?.value).toBe('scale');
    expect(anim['type']?.value).toBe('in');
  });

  it('computed-matrix keyframe endpoints parse (matrix translation → slide)', () => {
    const anim = emittedAnimation(
      entranceNode({
        keyframeProps: ['transform'],
        transform: { from: 'matrix(1, 0, 0, 1, 0, 40)', to: 'matrix(1, 0, 0, 1, 0, 0)' },
      }),
    );
    expect(anim['effect']?.value).toBe('slide');
    expect(anim['direction']?.value).toBe('bottom');
  });

  it('translate dominates scale, scale dominates opacity (the §4 priority order)', () => {
    const anim = emittedAnimation(
      entranceNode({
        keyframeProps: ['opacity', 'transform'],
        opacity: { from: 0, to: 1 },
        transform: { from: 'translateY(30px) scale(0.9)', to: 'none' },
      }),
    );
    expect(anim['effect']?.value).toBe('slide');
  });

  it('rotation-only keyframes are honestly non-expressible → tier 4 with reason', () => {
    const node = entranceNode({
      keyframeProps: ['transform'],
      transform: { from: 'rotate(0deg)', to: 'rotate(360deg)' },
    });
    const res = emitInteractions([widgetEl('abc1234')], [node], ctx());
    expect(res.report[0]?.tier).toBe(4);
    expect(res.report[0]?.reason).toMatch(/no opacity\/translate\/scale intent/);
    expect((res.elements[0] as AtomicWidgetNode).interactions).toEqual([]); // untouched
  });

  it('keyframes animating only background-color → tier 4 with reason', () => {
    const node = entranceNode({ keyframeProps: ['background-color'] });
    const res = emitInteractions([widgetEl('abc1234')], [node], ctx());
    expect(res.report[0]?.tier).toBe(4);
    expect(res.report[0]?.reason).toContain('background-color');
  });
});

/* ─────────────────────────── timing (§4 clamp/default) ───────────────────────────────────────── */

describe('duration/delay/easing', () => {
  function timing(node: IrNode): { duration: number; delay: number } {
    const item = firstItem(
      emitInteractions([widgetEl('abc1234')], [node], ctx()).elements[0] as ElementNode,
    ) as {
      value: {
        animation: {
          value: {
            timing_config: {
              value: {
                duration: { value: { size: number } };
                delay: { value: { size: number } };
              };
            };
          };
        };
      };
    };
    const tc = item.value.animation.value.timing_config.value;
    return { duration: tc.duration.value.size, delay: tc.delay.value.size };
  }

  it('parses computed seconds and ms', () => {
    expect(timing(entranceNode({ opacity: { from: 0, to: 1 }, duration: '1.2s' })).duration).toBe(
      1200,
    );
    expect(timing(entranceNode({ opacity: { from: 0, to: 1 }, duration: '350ms' })).duration).toBe(
      350,
    );
  });

  it(`clamps durations below ${MIN_DURATION_MS}ms up to the floor`, () => {
    expect(timing(entranceNode({ opacity: { from: 0, to: 1 }, duration: '0.05s' })).duration).toBe(
      MIN_DURATION_MS,
    );
  });

  it(`defaults a zero/unparseable duration to ${DEFAULT_DURATION_MS}ms`, () => {
    expect(timing(entranceNode({ opacity: { from: 0, to: 1 }, duration: '0s' })).duration).toBe(
      DEFAULT_DURATION_MS,
    );
    expect(
      timing(entranceNode({ opacity: { from: 0, to: 1 }, duration: 'garbage' })).duration,
    ).toBe(DEFAULT_DURATION_MS);
  });

  it('parses delay (default 0, never negative)', () => {
    expect(timing(entranceNode({ opacity: { from: 0, to: 1 }, delay: '0.25s' })).delay).toBe(250);
    expect(timing(entranceNode({ opacity: { from: 0, to: 1 }, delay: '-1s' })).delay).toBe(0);
  });

  function easingOf(node: IrNode, c = ctx()): unknown {
    const item = firstItem(
      emitInteractions([widgetEl('abc1234')], [node], c).elements[0] as ElementNode,
    ) as {
      value: {
        animation: { value: { config?: { value: { easing: { value: string } } } } };
      };
    };
    return item.value.animation.value.config?.value.easing.value;
  }

  it('maps CSS timing functions to Elementor presets', () => {
    expect(easingOf(entranceNode({ opacity: { from: 0, to: 1 }, easing: 'ease-in' }))).toBe(
      'easeIn',
    );
    expect(easingOf(entranceNode({ opacity: { from: 0, to: 1 }, easing: 'ease-out' }))).toBe(
      'easeOut',
    );
    expect(easingOf(entranceNode({ opacity: { from: 0, to: 1 }, easing: 'ease-in-out' }))).toBe(
      'easeInOut',
    );
    expect(easingOf(entranceNode({ opacity: { from: 0, to: 1 }, easing: 'linear' }))).toBe(
      'linear',
    );
  });

  it('omits config for cubic-bezier (never guesses a preset)', () => {
    expect(
      easingOf(
        entranceNode({ opacity: { from: 0, to: 1 }, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }),
      ),
    ).toBeUndefined();
  });

  it('Pro-gates easings beyond easeIn: free site degrades to default easing with a warning', () => {
    const node = entranceNode({ opacity: { from: 0, to: 1 }, easing: 'ease-out' });
    const free = ctx({ capabilities: caps({ pro: false }) });
    expect(easingOf(node, free)).toBeUndefined();
    const res = emitInteractions([widgetEl('abc1234')], [node], free);
    expect(res.report[0]?.tier).toBe(2); // degraded, never dropped
    expect(res.warnings.some((w) => w.includes("easing 'easeOut' requires Elementor Pro"))).toBe(
      true,
    );
    // easeIn stays free.
    const easeIn = entranceNode({ opacity: { from: 0, to: 1 }, easing: 'ease-in' });
    expect(easingOf(easeIn, free)).toBe('easeIn');
  });
});

/* ─────────────────────────── triggers (§4 scrollIn/load/hover) ───────────────────────────────── */

describe('triggers', () => {
  function triggerOf(node: IrNode, c = ctx()): unknown {
    const item = firstItem(
      emitInteractions([widgetEl('abc1234')], [node], c).elements[0] as ElementNode,
    ) as { value: { trigger: { value: string } } };
    return item.value.trigger.value;
  }

  it('plain keyframes → load', () => {
    expect(triggerOf(entranceNode({ opacity: { from: 0, to: 1 } }))).toBe('load');
  });

  it('data-aos attr → scrollIn (free trigger — no Pro needed)', () => {
    const node = entranceNode(
      { opacity: { from: 0, to: 1 } },
      { attrs: { 'data-aos': 'fade' } },
    );
    expect(triggerOf(node, ctx({ capabilities: caps({ pro: false }) }))).toBe('scrollIn');
  });

  it('scroll-reveal library classnames (aos/wow/reveal) → scrollIn', () => {
    for (const cls of ['aos', 'wow', 'sr-reveal']) {
      const node = entranceNode({ opacity: { from: 0, to: 1 } }, { attrs: { class: cls } });
      expect(triggerOf(node)).toBe('scrollIn');
    }
    // ambiguity rule: 'chaos'/'wowzers' are NOT scroll signals (exact-token match).
    const node = entranceNode(
      { opacity: { from: 0, to: 1 } },
      { attrs: { class: 'chaos wowzers' } },
    );
    expect(triggerOf(node)).toBe('load');
  });

  it('hover-effect on a Pro site → trigger hover', () => {
    const node = hoverNode({ transform: 'matrix(1.05, 0, 0, 1.05, 0, 0)' });
    expect(triggerOf(node)).toBe('hover');
  });

  it('hover-effect on a free site → tier 4 (hover is Pro-gated per S08)', () => {
    const node = hoverNode({ transform: 'matrix(1.05, 0, 0, 1.05, 0, 0)' });
    const res = emitInteractions(
      [widgetEl('abc1234')],
      [node],
      ctx({ capabilities: caps({ pro: false }) }),
    );
    expect(res.report[0]?.tier).toBe(4);
    expect(res.report[0]?.reason).toMatch(/hover.*requires Elementor Pro/);
    expect((res.elements[0] as AtomicWidgetNode).interactions).toEqual([]);
  });
});

/* ─────────────────────────── hover-effect intent ─────────────────────────────────────────────── */

describe('hover-effect mapping', () => {
  function emitted(node: IrNode): {
    report: DetectedBehavior[];
    anim?: Record<string, { value: unknown }>;
  } {
    const res = emitInteractions([widgetEl('abc1234')], [node], ctx());
    if (res.report[0]?.tier !== 2) return { report: res.report };
    const item = firstItem(res.elements[0] as ElementNode) as {
      value: { animation: { value: Record<string, { value: unknown }> } };
    };
    return { report: res.report, anim: item.value.animation.value };
  }

  it('hover scale-up (computed matrix) → scale in with the transition timing', () => {
    const { anim } = emitted(
      hoverNode({ transform: 'matrix(1.05, 0, 0, 1.05, 0, 0)' }, { duration: '0.3s' }),
    );
    expect(anim?.['effect']?.value).toBe('scale');
    expect(anim?.['type']?.value).toBe('in');
  });

  it('hover opacity dim → fade out', () => {
    const node = hoverNode({ opacity: '0.6' });
    node.computed = { opacity: '1' };
    const { anim } = emitted(node);
    expect(anim?.['effect']?.value).toBe('fade');
    expect(anim?.['type']?.value).toBe('out');
  });

  it('hover lift (translateY(-6px), moves UP) → slide out toward top (runtime out-direction = side moved TOWARD)', () => {
    const { anim } = emitted(hoverNode({ transform: 'matrix(1, 0, 0, 1, 0, -6)' }));
    expect(anim?.['effect']?.value).toBe('slide');
    expect(anim?.['type']?.value).toBe('out');
    expect(anim?.['direction']?.value).toBe('top');
  });

  it('hover background-color-only delta → tier 4 with the changed props in the reason', () => {
    const { report } = emitted(hoverNode({ 'background-color': 'rgb(255, 0, 0)' }));
    expect(report[0]?.tier).toBe(4);
    expect(report[0]?.reason).toContain('background-color');
  });
});

/* ─────────────────────────── declarative (no-probe) entrance fallbacks ───────────────────────── */

describe('declarative entrance fallbacks', () => {
  function emitOne(node: IrNode): {
    report: DetectedBehavior[];
    anim?: Record<string, { value: unknown }>;
    el: ElementNode;
  } {
    const res = emitInteractions([widgetEl('abc1234')], [node], ctx());
    const el = res.elements[0] as ElementNode;
    if (res.report[0]?.tier !== 2) return { report: res.report, el };
    const item = firstItem(el) as {
      value: { animation: { value: Record<string, { value: unknown }> } };
    };
    return { report: res.report, anim: item.value.animation.value, el };
  }

  function aosOnly(value: string, extraAttrs: Record<string, string> = {}): IrNode {
    const node = irNode({ attrs: { 'data-aos': value, ...extraAttrs } });
    node.behaviors = [
      behavior('entrance-animation', node.source_path, { evidence: ['attr:data-aos'] }),
    ];
    return node;
  }

  it('data-aos="fade" → fade in on scrollIn', () => {
    const { anim } = emitOne(aosOnly('fade'));
    expect(anim?.['effect']?.value).toBe('fade');
    expect(anim?.['direction']?.value).toBe('');
  });

  it('data-aos="fade-up" → slide from bottom (motion dominates)', () => {
    const { anim } = emitOne(aosOnly('fade-up'));
    expect(anim?.['effect']?.value).toBe('slide');
    expect(anim?.['direction']?.value).toBe('bottom');
  });

  it('data-aos="fade-up-right" → compound direction bottom-left', () => {
    const { anim } = emitOne(aosOnly('fade-up-right'));
    expect(anim?.['direction']?.value).toBe('bottom-left');
  });

  it('data-aos="zoom-in" → scale in', () => {
    const { anim } = emitOne(aosOnly('zoom-in'));
    expect(anim?.['effect']?.value).toBe('scale');
    expect(anim?.['type']?.value).toBe('in');
  });

  it('data-aos="flip-left" → tier 4 (no fade/slide/scale equivalent)', () => {
    const { report } = emitOne(aosOnly('flip-left'));
    expect(report[0]?.tier).toBe(4);
    expect(report[0]?.reason).toContain('flip-left');
  });

  it('honors data-aos-duration/-delay (plain ms attrs) with the §4 clamp', () => {
    const { el } = emitOne(
      aosOnly('fade', { 'data-aos-duration': '1200', 'data-aos-delay': '150' }),
    );
    const item = firstItem(el) as {
      value: {
        animation: {
          value: {
            timing_config: {
              value: {
                duration: { value: { size: number } };
                delay: { value: { size: number } };
              };
            };
          };
        };
      };
    };
    const tc = item.value.animation.value.timing_config.value;
    expect(tc.duration.value.size).toBe(1200);
    expect(tc.delay.value.size).toBe(150);
  });

  it('classname fade token without a probe → fade in on load', () => {
    const node = irNode({ attrs: { class: 'hero fade-in' } });
    node.behaviors = [
      behavior('entrance-animation', node.source_path, { evidence: ['classname:fade-in'] }),
    ];
    const { anim, report } = emitOne(node);
    expect(report[0]?.tier).toBe(2);
    expect(anim?.['effect']?.value).toBe('fade');
  });

  it('bare library token (wow) → fade in on scrollIn, reason notes the assumed default', () => {
    const node = irNode({ attrs: { class: 'wow' } });
    node.behaviors = [
      behavior('entrance-animation', node.source_path, { evidence: ['classname:wow'] }),
    ];
    const res = emitInteractions([widgetEl('abc1234')], [node], ctx());
    expect(res.report[0]?.tier).toBe(2);
    expect(res.report[0]?.reason).toContain('assumed');
  });

  it('no probe, no data-aos, no preset classname → tier 4 (no extractable intent)', () => {
    const node = irNode({ attrs: { class: 'hero' } });
    node.behaviors = [
      behavior('entrance-animation', node.source_path, { evidence: ['classname:hero'] }),
    ];
    const { report } = emitOne(node);
    expect(report[0]?.tier).toBe(4);
    expect(report[0]?.reason).toContain('no extractable animation intent');
  });
});

/* ─────────────────────────── attachment, merging, and the 5-item cap ─────────────────────────── */

describe('attachment + cap', () => {
  it('attaches to a nested element resolved through id_map', () => {
    const tree = [containerEl('root111', [widgetEl('abc1234')])];
    const node = entranceNode({ opacity: { from: 0, to: 1 } });
    const res = emitInteractions(tree, [node], ctx());
    const root = res.elements[0] as AtomicContainerNode;
    // P3-c (contract 18 §7): the non-authored root's EMPTY `interactions: []` seed is pruned —
    // only interaction-bearing nodes keep a payload.
    expect(root.interactions).toBeUndefined();
    const child = root.elements?.[0] as AtomicWidgetNode;
    expect(blobOf(child).items).toHaveLength(1);
  });

  it('merges with pre-existing interactions (existing items kept first)', () => {
    const existing = {
      version: 1,
      items: [{ $$type: 'interaction-item', value: { marker: 'pre-existing' } }],
    };
    const el = widgetEl('abc1234');
    (el as { interactions?: unknown }).interactions = JSON.stringify(existing);
    const node = entranceNode({ opacity: { from: 0, to: 1 } });
    const res = emitInteractions([el], [node], ctx());
    const blob = blobOf(res.elements[0] as ElementNode);
    expect(blob.items).toHaveLength(2);
    expect(blob.items[0]).toEqual(existing.items[0]);
    expect(res.authored[0]?.items).toBe(2);
  });

  it(`caps at ${MAX_INTERACTIONS_PER_ELEMENT} items per element — overflow lands tier 4 with the cap reason`, () => {
    const el = widgetEl('abc1234');
    (el as { interactions?: unknown }).interactions = JSON.stringify({
      version: 1,
      items: Array.from({ length: 4 }, () => ({ $$type: 'interaction-item', value: {} })),
    });
    // Two candidates on the same element: entrance + hover.
    const node = entranceNode({ opacity: { from: 0, to: 1 } });
    node.transitionProbe = { property: 'all', duration: '0.3s', easing: 'ease-in' };
    node.hoverComputed = { transform: 'matrix(1.05, 0, 0, 1.05, 0, 0)' };
    node.behaviors = [
      behavior('entrance-animation', node.source_path),
      behavior('hover-effect', node.source_path, { evidence: ['hover-delta:transform'] }),
    ];
    const res = emitInteractions([el], [node], ctx());
    expect(res.report.map((r) => r.tier)).toEqual([2, 4]);
    expect(res.report[1]?.reason).toContain(`exceeds ${MAX_INTERACTIONS_PER_ELEMENT}`);
    expect(blobOf(res.elements[0] as ElementNode).items).toHaveLength(5);
  });

  it('an element already at the cap rejects every new candidate', () => {
    const el = widgetEl('abc1234');
    (el as { interactions?: unknown }).interactions = JSON.stringify({
      version: 1,
      items: Array.from({ length: 5 }, () => ({ $$type: 'interaction-item', value: {} })),
    });
    const node = entranceNode({ opacity: { from: 0, to: 1 } });
    const res = emitInteractions([el], [node], ctx());
    expect(res.report[0]?.tier).toBe(4);
    expect(res.authored).toEqual([]);
    // the original string is untouched.
    expect(blobOf(res.elements[0] as ElementNode).items).toHaveLength(5);
  });

  it('refuses to overwrite an undecodable existing interactions string (tier 4 + warning)', () => {
    const el = widgetEl('abc1234');
    (el as { interactions?: unknown }).interactions = '{not json';
    const node = entranceNode({ opacity: { from: 0, to: 1 } });
    const res = emitInteractions([el], [node], ctx());
    expect(res.report[0]?.tier).toBe(4);
    expect(res.report[0]?.reason).toContain('undecodable');
    expect((res.elements[0] as { interactions?: unknown }).interactions).toBe('{not json');
    expect(res.warnings.some((w) => w.includes('undecodable'))).toBe(true);
  });
});

/* ─────────────────────────── gating + resolution failures (honest tier 4) ────────────────────── */

describe('gating + resolution', () => {
  it('id_map miss → tier 4, elements untouched', () => {
    const node = entranceNode({ opacity: { from: 0, to: 1 } });
    const res = emitInteractions([widgetEl('abc1234')], [node], ctx({ id_map: {} }));
    expect(res.report[0]?.tier).toBe(4);
    expect(res.report[0]?.reason).toContain('id_map miss');
    expect((res.elements[0] as AtomicWidgetNode).interactions).toEqual([]);
  });

  it('mapped id missing from the tree → tier 4', () => {
    const node = entranceNode({ opacity: { from: 0, to: 1 } });
    const res = emitInteractions(
      [widgetEl('zzz9999')],
      [node],
      ctx({ id_map: { 'body>div': 'abc1234' } }),
    );
    expect(res.report[0]?.tier).toBe(4);
    expect(res.report[0]?.reason).toContain("'abc1234' not found");
  });

  it('classic (non-atomic) target → tier 4 (interactions are V4-only)', () => {
    const node = entranceNode({ opacity: { from: 0, to: 1 } });
    const res = emitInteractions([classicEl('abc1234')], [node], ctx());
    expect(res.report[0]?.tier).toBe(4);
    expect(res.report[0]?.reason).toContain('not atomic');
  });

  it('atomic capability off → every candidate tier 4', () => {
    const node = entranceNode({ opacity: { from: 0, to: 1 } });
    const res = emitInteractions(
      [widgetEl('abc1234')],
      [node],
      ctx({ capabilities: caps({ atomic: false }) }),
    );
    expect(res.report[0]?.tier).toBe(4);
    expect(res.report[0]?.reason).toContain('e_atomic_elements');
  });

  it('explicitly deactivated e_interactions experiment → tier 4', () => {
    const node = entranceNode({ opacity: { from: 0, to: 1 } });
    const res = emitInteractions(
      [widgetEl('abc1234')],
      [node],
      ctx({ capabilities: caps({ experiments: { e_interactions: false } }) }),
    );
    expect(res.report[0]?.tier).toBe(4);
    expect(res.report[0]?.reason).toContain('e_interactions');
  });
});

/* ─────────────────────────── honesty invariants (§8) ─────────────────────────────────────────── */

describe('honesty invariants', () => {
  it('invariant 1: count(candidates) == count(report) and every entry carries a tier', () => {
    const a = entranceNode({ opacity: { from: 0, to: 1 } });
    const b = hoverNode({ transform: 'matrix(1.1, 0, 0, 1.1, 0, 0)' }, {}, {
      source_path: 'body>section',
    });
    b.behaviors = [behavior('hover-effect', 'body>section')];
    const c = irNode({ source_path: 'body>footer' });
    c.behaviors = [behavior('entrance-animation', 'body>footer')]; // no intent → tier 4
    const res = emitInteractions(
      [widgetEl('abc1234'), widgetEl('def5678'), widgetEl('aaa1111')],
      [a, b, c],
      ctx({
        id_map: {
          'body>div': 'abc1234',
          'body>section': 'def5678',
          'body>footer': 'aaa1111',
        },
      }),
    );
    expect(res.report).toHaveLength(3);
    expect(res.report.every((r) => r.tier === 2 || r.tier === 4)).toBe(true);
    expect(res.report.every((r) => typeof r.reason === 'string' && r.reason !== '')).toBe(true);
  });

  it('non-tier-2 behavior kinds (tabs/carousel/…) are NOT consumed and NOT reported here', () => {
    const node = irNode();
    node.behaviors = [behavior('tabs'), behavior('carousel'), behavior('custom-js')];
    const res = emitInteractions([widgetEl('abc1234')], [node], ctx());
    expect(res.report).toEqual([]);
    expect(res.authored).toEqual([]);
  });

  it('invariant 5: zero behaviors → byte-identical element passthrough, inputs never mutated', () => {
    const input = [containerEl('root111', [widgetEl('abc1234')])];
    const snapshot = structuredClone(input);
    const res = emitInteractions(input, [irNode()], ctx());
    expect(res.elements).toEqual(snapshot);
    expect(res.elements).not.toBe(input); // a clone, not the same reference
    expect(input).toEqual(snapshot);
    expect(res.report).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it('inputs are never mutated even when emitting (pure stage)', () => {
    const input = [widgetEl('abc1234')];
    const node = entranceNode({ opacity: { from: 0, to: 1 } });
    const irSnapshot = structuredClone([node]);
    emitInteractions(input, [node], ctx());
    expect(input[0]?.interactions).toEqual([]); // input untouched
    expect([node]).toEqual(irSnapshot); // IR behaviors keep tier unset (detection's frozen rule)
    expect(node.behaviors?.[0]?.tier).toBeUndefined();
  });

  it('every emitted blob is valid JSON with version 1 and ≤5 items', () => {
    const node = entranceNode({ opacity: { from: 0, to: 1 } });
    const res = emitInteractions([widgetEl('abc1234')], [node], ctx());
    const blob = blobOf(res.elements[0] as ElementNode);
    expect(blob.version).toBe(1);
    expect(blob.items.length).toBeLessThanOrEqual(MAX_INTERACTIONS_PER_ELEMENT);
  });
});

/* ─────────────────────────── decodeInteractionItems ──────────────────────────────────────────── */

describe('decodeInteractionItems', () => {
  it('accepts all three wire forms (S08)', () => {
    expect(decodeInteractionItems(undefined)).toEqual([]);
    expect(decodeInteractionItems([])).toEqual([]); // PHP empty
    expect(decodeInteractionItems({ version: 1, items: [1, 2] })).toEqual([1, 2]);
    expect(decodeInteractionItems('{"version":1,"items":[1]}')).toEqual([1]);
    expect(decodeInteractionItems('')).toEqual([]);
  });

  it('returns null for undecodable values', () => {
    expect(decodeInteractionItems('{nope')).toBeNull();
    expect(decodeInteractionItems({ items: 'not-an-array' })).toBeNull();
    expect(decodeInteractionItems(42)).toBeNull();
  });
});

/* ─────────────────────────── postSaveAssert (§8 invariant 2) ─────────────────────────────────── */

describe('postSaveAssert', () => {
  const authored: AuthoredInteractions[] = [
    { element_id: 'abc1234', source_path: 'body>div', items: 2 },
    { element_id: 'def5678', source_path: 'body>section', items: 1 },
  ];

  function readBackEl(id: string, interactions: unknown): ElementNode {
    const el = widgetEl(id);
    (el as { interactions?: unknown }).interactions = interactions;
    return el;
  }

  it('flags an element whose authored interactions came back empty as dropped_by_sanitizer', () => {
    const readBack = [
      readBackEl('abc1234', JSON.stringify({ version: 1, items: [{}, {}] })),
      readBackEl('def5678', []), // PHP stores [] when every item was invalid (S08 silent drop)
    ];
    expect(postSaveAssert(authored, readBack)).toEqual([
      { element_id: 'abc1234', authored: 2, survived: 2, status: 'survived' },
      { element_id: 'def5678', authored: 1, survived: 0, status: 'dropped_by_sanitizer' },
    ]);
  });

  it('flags partial survival', () => {
    const readBack = [
      readBackEl('abc1234', JSON.stringify({ version: 1, items: [{}] })),
      readBackEl('def5678', JSON.stringify({ version: 1, items: [{}] })),
    ];
    expect(postSaveAssert(authored, readBack)[0]).toEqual({
      element_id: 'abc1234',
      authored: 2,
      survived: 1,
      status: 'partial',
    });
  });

  it('flags a missing element', () => {
    expect(postSaveAssert(authored, [readBackEl('abc1234', '[]')])[1]).toEqual({
      element_id: 'def5678',
      authored: 1,
      survived: 0,
      status: 'element_missing',
    });
  });

  it('accepts the decoded-object read-back form and finds nested elements', () => {
    const nested = containerEl('root111', [
      readBackEl('abc1234', { version: 1, items: [{}, {}] }),
    ]);
    const checks = postSaveAssert(
      [{ element_id: 'abc1234', source_path: 'body>div', items: 2 }],
      [nested],
    );
    expect(checks[0]?.status).toBe('survived');
  });

  it('treats an undecodable read-back value as zero survival', () => {
    const checks = postSaveAssert(
      [{ element_id: 'abc1234', source_path: 'body>div', items: 1 }],
      [readBackEl('abc1234', '{corrupt')],
    );
    expect(checks[0]?.status).toBe('dropped_by_sanitizer');
  });

  it('round-trips with emitInteractions output (authored → assert)', () => {
    const node = entranceNode({ opacity: { from: 0, to: 1 } });
    const res = emitInteractions([widgetEl('abc1234')], [node], ctx());
    // Simulate a faithful save: the read-back tree is exactly what we authored.
    expect(postSaveAssert(res.authored, res.elements)).toEqual([
      { element_id: 'abc1234', authored: 1, survived: 1, status: 'survived' },
    ]);
    // Simulate the sanitizer wiping it.
    const wiped = structuredClone(res.elements);
    ((wiped[0] as ElementNode) as { interactions?: unknown }).interactions = '[]';
    expect(postSaveAssert(res.authored, wiped)[0]?.status).toBe('dropped_by_sanitizer');
  });
});

/* ─────────────────────────── P3-c — interaction-bearing payload census (contract 18 §7) ──────── */

describe('P3-c: only interaction-bearing nodes carry an interactions payload', () => {
  it('prunes the ASSEMBLE-seeded empty `interactions: []` from every non-authored element', () => {
    // The Driftwell symptom in miniature: every minted element carries `interactions: []`.
    const tree = [
      containerEl('root111', [widgetEl('abc1234'), widgetEl('bbb2222'), widgetEl('ccc3333')]),
    ];
    const node = entranceNode({ opacity: { from: 0, to: 1 } });
    const res = emitInteractions(tree, [node], ctx());

    expect(res.authored.map((a) => a.element_id)).toEqual(['abc1234']);
    // bearing census == authored exactly (the §7 P3-c corpus guard).
    expect(collectInteractionBearingIds(res.elements)).toEqual(['abc1234']);
    // …and the empty seeds are gone, not just empty.
    const root = res.elements[0] as AtomicContainerNode;
    expect(root.interactions).toBeUndefined();
    expect((root.elements?.[1] as AtomicWidgetNode).interactions).toBeUndefined();
    expect((root.elements?.[2] as AtomicWidgetNode).interactions).toBeUndefined();
  });

  it('pre-existing NON-empty payloads on non-authored elements survive the prune (still bearing)', () => {
    const other = widgetEl('bbb2222');
    (other as { interactions?: unknown }).interactions = JSON.stringify({
      version: 1,
      items: [buildInteractionItem({ trigger: 'load', effect: 'fade', type: 'in', direction: '', durationMs: 300, delayMs: 0, easing: null })],
    });
    const tree = [containerEl('root111', [widgetEl('abc1234'), other])];
    const node = entranceNode({ opacity: { from: 0, to: 1 } });
    const res = emitInteractions(tree, [node], ctx());
    expect(collectInteractionBearingIds(res.elements).sort()).toEqual(['abc1234', 'bbb2222']);
  });

  it('a fully-rejected candidate set leaves the forest untouched (reject ⇒ no side effects)', () => {
    const tree = [containerEl('root111', [widgetEl('abc1234')])];
    const node = entranceNode({ opacity: { from: 0, to: 1 } });
    const res = emitInteractions(tree, [node], ctx({ id_map: {} })); // id_map miss → all tier 4
    expect(res.authored).toEqual([]);
    expect(res.elements).toEqual(tree); // empty seeds INTACT — nothing was authored
  });

  it('an honest tier-4 drop never removes the element itself (P2-c element-survival half)', () => {
    // The pulse dot reaches the emitter with an unmappable looping probe: tier 4 + element kept.
    const node = entranceNode({
      name: 'pulse',
      keyframeProps: ['opacity', 'transform'],
      // loops back to identity — no extractable fade/slide/scale intent
      opacity: { from: 1, to: 1 },
      transform: { from: 'none', to: 'none' },
    });
    const tree = [containerEl('root111', [widgetEl('abc1234')])];
    const res = emitInteractions(tree, [node], ctx());
    expect(res.report[0]?.tier).toBe(4);
    expect(res.report[0]?.reason).toMatch(/no opacity\/translate\/scale intent/);
    // the element is still in the output forest, untouched.
    const root = res.elements[0] as AtomicContainerNode;
    expect(root.elements?.[0]?.id).toBe('abc1234');
  });

  it('collectInteractionBearingIds counts undecodable payloads as bearing (broken ≠ hidden)', () => {
    const el = widgetEl('abc1234');
    (el as { interactions?: unknown }).interactions = '{corrupt';
    expect(collectInteractionBearingIds([el])).toEqual(['abc1234']);
    expect(collectInteractionBearingIds([widgetEl('bbb2222')])).toEqual([]); // empty [] not bearing
  });
});

/* ─────────────────────────── P1-c — diagnoseInteractionWiring (contract 18 §7) ───────────────── */

describe('P1-c: diagnoseInteractionWiring', () => {
  function emitOne(): { authored: AuthoredInteractions[]; elements: ElementNode[] } {
    const node = entranceNode({ opacity: { from: 0, to: 1 } });
    const res = emitInteractions([containerEl('root111', [widgetEl('abc1234')])], [node], ctx());
    return { authored: res.authored, elements: res.elements };
  }

  it('a faithful save round-trip diagnoses fully wired', () => {
    const { authored, elements } = emitOne();
    const diag = diagnoseInteractionWiring(authored, elements);
    expect(diag.ok).toBe(true);
    expect(diag.findings).toHaveLength(1);
    expect(diag.findings[0]).toMatchObject({
      element_id: 'abc1234',
      expected_stamp: 'abc1234', // blob elementId ↔ data-interaction-id correspondence leg
      authored_items: 1,
      found_items: 1,
      status: 'wired',
      problems: [],
    });
    expect(diag.bearing_ids).toEqual(['abc1234']);
    expect(diag.summary).toContain('1/1');
  });

  it('flags a vanished element (the blob row would match no stamped node)', () => {
    const { authored } = emitOne();
    const diag = diagnoseInteractionWiring(authored, [containerEl('root111', [])]);
    expect(diag.ok).toBe(false);
    expect(diag.findings[0]?.status).toBe('element_missing');
    expect(diag.findings[0]?.problems[0]).toMatch(/remapped_ids/);
  });

  it('flags a non-atomic host (classic widgets are never stamped with data-interaction-id)', () => {
    const { authored, elements } = emitOne();
    const blob = ((elements[0] as AtomicContainerNode).elements?.[0] as { interactions?: unknown })
      .interactions;
    const classic = classicEl('abc1234');
    (classic as { interactions?: unknown }).interactions = blob;
    const diag = diagnoseInteractionWiring(authored, [classic]);
    expect(diag.findings[0]?.status).toBe('not_atomic');
    expect(diag.findings[0]?.problems[0]).toMatch(/Atomic_Element_Base/);
  });

  it('flags sanitizer item loss', () => {
    const { authored, elements } = emitOne();
    const wiped = structuredClone(elements);
    const host = (wiped[0] as AtomicContainerNode).elements?.[0] as { interactions?: unknown };
    host.interactions = JSON.stringify({ version: 1, items: [] });
    const diag = diagnoseInteractionWiring(authored, wiped);
    expect(diag.findings[0]?.status).toBe('items_lost');
    expect(diag.findings[0]?.problems[0]).toMatch(/Validation::sanitize/);
  });

  it('flags an undecodable saved payload', () => {
    const { authored, elements } = emitOne();
    const broken = structuredClone(elements);
    ((broken[0] as AtomicContainerNode).elements?.[0] as { interactions?: unknown }).interactions =
      '{corrupt';
    const diag = diagnoseInteractionWiring(authored, broken);
    expect(diag.findings[0]?.status).toBe('undecodable');
    expect(diag.findings[0]?.found_items).toBe(-1);
  });

  it('flags items the runtime would silently no-op (empty getKeyframes ⇒ no initial state)', () => {
    // A slide with NO direction produces empty keyframes in the runtime — saved fine, animates nothing.
    const el = widgetEl('abc1234');
    (el as { interactions?: unknown }).interactions = JSON.stringify({
      version: 1,
      items: [
        buildInteractionItem({
          trigger: 'scrollIn',
          effect: 'slide',
          type: 'in',
          direction: '',
          durationMs: 600,
          delayMs: 0,
          easing: null,
        }),
      ],
    });
    const diag = diagnoseInteractionWiring(
      [{ element_id: 'abc1234', source_path: 'body>div', items: 1 }],
      [el],
    );
    expect(diag.findings[0]?.status).toBe('no_runtime_effect');
    expect(diag.findings[0]?.problems[0]).toMatch(/EMPTY keyframes/);
  });

  it('flags an unsupported trigger (free runtime handles only load/scrollIn/scrollOut)', () => {
    const el = widgetEl('abc1234');
    (el as { interactions?: unknown }).interactions = JSON.stringify({
      version: 1,
      items: [
        buildInteractionItem({
          trigger: 'click',
          effect: 'fade',
          type: 'in',
          direction: '',
          durationMs: 600,
          delayMs: 0,
          easing: null,
        }),
      ],
    });
    const diag = diagnoseInteractionWiring(
      [{ element_id: 'abc1234', source_path: 'body>div', items: 1 }],
      [el],
    );
    expect(diag.findings[0]?.status).toBe('no_runtime_effect');
    expect(diag.findings[0]?.problems[0]).toMatch(/trigger 'click' is unsupported/);
  });

  it('a hover item is wired (handled by the Pro runtime, already Pro-gated at emission)', () => {
    const node = hoverNode({ opacity: '0.6' });
    const res = emitInteractions([widgetEl('abc1234')], [node], ctx());
    const diag = diagnoseInteractionWiring(res.authored, res.elements);
    expect(diag.findings[0]?.status).toBe('wired');
  });

  it('is pure: diagnosing never mutates the saved tree', () => {
    const { authored, elements } = emitOne();
    const before = structuredClone(elements);
    diagnoseInteractionWiring(authored, elements);
    expect(elements).toEqual(before);
  });
});
