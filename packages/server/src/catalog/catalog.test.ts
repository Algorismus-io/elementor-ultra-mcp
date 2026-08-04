/**
 * WP-F04 — catalog conformance tests (Tests Required, WP-F04 ticket).
 *
 * Asserts the live catalog against the committed `catalog.snapshot.json` (drift fails CI), the lean ★
 * set (§5.2), annotations (§0.3), the ZodRawShape rule (no top-level `z.object` as a schema, §0.1), the
 * pagination shape on every list tool (§0.6), tool↔route coverage against WP-F02's `ROUTES` (§1 impl
 * note 8), and zod-vs-JSON-Schema agreement for `Diff`/`DryRunResult`/`CoverageReport` (§Tests).
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z, ZodObject } from 'zod';

import { ROUTES } from '@elementor-ultra/shared';

import { TOOL_DESCRIPTORS, TOOL_NAMES, TOOL_COUNT, TOOL_NAME_PATTERN } from './tools.js';
import { RESOURCE_DESCRIPTORS, RESOURCE_URI_PATTERN } from './resources.js';
import { PROMPT_DESCRIPTORS } from './prompts.js';
import {
  LEAN_STAR_TOOLS,
  RETIRED_TOOLS,
  retiredToolNames,
  LEAN_STAR_COUNT,
  META_TOOLS,
  enabledToolNamesForProfile,
  resolveProfile,
} from './profiles.js';
import {
  diffSchema,
  dryRunErrorSchema,
  elementNodeSchema,
  fieldProjectedItem,
  pageSettingsSchema,
  pageSettingsInputSchema,
  validationErrorSchema,
  coverageReportSchema,
  paginationInputShape,
  paginationOutputShape,
} from './schemas/shared.js';
import { pageDryRunOutput } from './schemas/page.js';
import { opsLogOutput } from './schemas/ops.js';
import { templatesGetOutput, templatesListOutput } from './schemas/templates.js';

interface SnapshotTool {
  name: string;
  star: boolean;
  class: 'R' | 'M' | 'D';
  side: string;
  route?: string;
  meta?: boolean;
  annotations: { readOnlyHint: boolean; idempotentHint: boolean; destructiveHint: boolean };
}
interface Snapshot {
  tool_count: number;
  star_count: number;
  lean_star_tools: string[];
  tools: SnapshotTool[];
  resource_count: number;
  resources: { uri: string; name: string; route: string; template: boolean }[];
  prompt_count: number;
  prompts: string[];
}

const snapshot = JSON.parse(
  readFileSync(new URL('./catalog.snapshot.json', import.meta.url), 'utf8'),
) as Snapshot;

/* ───────────────────────────── snapshot drift ──────────────────────────────────────────── */

describe('catalog snapshot (drift guard)', () => {
  it('tool/resource/prompt counts match the committed snapshot', () => {
    expect(TOOL_COUNT).toBe(snapshot.tool_count);
    expect(RESOURCE_DESCRIPTORS.length).toBe(snapshot.resource_count);
    expect(PROMPT_DESCRIPTORS.length).toBe(snapshot.prompt_count);
  });

  it('every tool name + flags matches the snapshot exactly', () => {
    const live = TOOL_DESCRIPTORS.map((t) => ({
      name: t.name,
      star: t.star,
      class: t.class,
      side: t.side,
      ...(t.route !== undefined ? { route: t.route } : {}),
      ...(t.meta === true ? { meta: true } : {}),
      annotations: {
        readOnlyHint: t.annotations.readOnlyHint ?? false,
        idempotentHint: t.annotations.idempotentHint ?? false,
        destructiveHint: t.annotations.destructiveHint ?? false,
      },
    }));
    expect(live).toEqual(snapshot.tools);
  });

  it('resource + prompt names match the snapshot', () => {
    expect(RESOURCE_DESCRIPTORS.map((r) => r.uri)).toEqual(snapshot.resources.map((r) => r.uri));
    expect(PROMPT_DESCRIPTORS.map((p) => p.name)).toEqual(snapshot.prompts);
  });
});

/* ───────────────────────────── names + uniqueness ──────────────────────────────────────── */

describe('tool names (§0.2)', () => {
  it('all tool names match the frozen pattern', () => {
    for (const name of TOOL_NAMES) {
      expect(name, name).toMatch(TOOL_NAME_PATTERN);
    }
  });

  it('all tool names are unique', () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  });

  it('every tool name is dot-namespaced under `elementor.`', () => {
    for (const name of TOOL_NAMES) {
      expect(name.startsWith('elementor.'), name).toBe(true);
    }
  });
});

/* ───────────────────────────── lean ★ profile (§5.2) ───────────────────────────────────── */

describe('lean ★ profile (§5.2)', () => {
  it('exactly 18 ★ tools', () => {
    const starNames = TOOL_DESCRIPTORS.filter((t) => t.star).map((t) => t.name);
    expect(starNames.length).toBe(LEAN_STAR_COUNT);
    expect(LEAN_STAR_TOOLS.length).toBe(LEAN_STAR_COUNT);
  });

  it('the descriptor ★ set equals the §5.2 LEAN_STAR_TOOLS list exactly', () => {
    const starNames = new Set(TOOL_DESCRIPTORS.filter((t) => t.star).map((t) => t.name));
    expect(starNames).toEqual(new Set(LEAN_STAR_TOOLS));
  });

  it('lean profile enables exactly the ★ set + the meta-trio', () => {
    const enabled = enabledToolNamesForProfile('lean');
    expect(enabled).toEqual(new Set<string>([...LEAN_STAR_TOOLS, ...META_TOOLS]));
    expect(META_TOOLS.length).toBe(3);
  });

  it('full profile enables every tool except the retired set', () => {
    const enabled = enabledToolNamesForProfile('full');
    expect(enabled.size).toBe(TOOL_COUNT - RETIRED_TOOLS.length);
    for (const name of RETIRED_TOOLS) {
      expect(enabled.has(name)).toBe(false);
    }
  });

  it('retired tools: figma one-shot retired by default, ULTRA_FIGMA=1 opts back in (dev only)', () => {
    expect(RETIRED_TOOLS).toEqual([
      'elementor.convert.figma_to_tree',
      'elementor.convert.figma_to_page',
    ]);
    expect(retiredToolNames({})).toEqual(RETIRED_TOOLS);
    expect(retiredToolNames({ ULTRA_FIGMA: '1' })).toEqual([]);
    // The descriptors STAY in the frozen catalog (retirement is a registration gate, not a removal).
    for (const name of RETIRED_TOOLS) {
      expect(TOOL_NAMES.includes(name)).toBe(true);
    }
  });

  it('ULTRA_TOOLS resolution (§5.4)', () => {
    expect(resolveProfile(undefined)).toBe('lean');
    expect(resolveProfile('')).toBe('lean');
    expect(resolveProfile('lean')).toBe('lean');
    expect(resolveProfile('FULL')).toBe('full');
    expect(resolveProfile('garbage')).toBe('lean');
  });
});

/* ───────────────────────────── annotations (§0.3) ──────────────────────────────────────── */

describe('annotations (§0.3)', () => {
  it('class D tools are destructive; class R tools are read-only', () => {
    for (const t of TOOL_DESCRIPTORS) {
      if (t.class === 'D') {
        expect(t.annotations.destructiveHint, t.name).toBe(true);
      }
      if (t.class === 'R' && t.meta !== true) {
        // Read tools declare readOnlyHint (the meta-trio `tools.invoke` is the documented exception:
        // it inherits the target's annotations at call time).
        expect(t.annotations.readOnlyHint, t.name).toBe(true);
      }
    }
  });

  it('idempotent-write tools declare idempotentHint', () => {
    // Sanity on the positive direction: the §1 idempotent writes carry the hint.
    const idempotentWrites = [
      'elementor.widget.update_settings',
      'elementor.element.set_classes',
      'elementor.design.classes.upsert',
      'elementor.media.sideload_url',
    ];
    for (const name of idempotentWrites) {
      const t = TOOL_DESCRIPTORS.find((d) => d.name === name);
      expect(t?.annotations.idempotentHint, name).toBe(true);
    }
  });

  it('a class-M tool is destructive ONLY when the contract documents a dual M/D class', () => {
    // `convert.html_to_page` is the documented exception (§1.9: "Class: M (new page) / D (replace)",
    // destructiveHint:true when committing against an existing post_id). `convert.figma_to_page`
    // (contract 18 §6) shares the same dual M/D semantics. No other class-M tool is.
    const dualClassMtools = new Set([
      'elementor.convert.html_to_page',
      'elementor.convert.figma_to_page',
    ]);
    for (const t of TOOL_DESCRIPTORS) {
      if (t.class === 'M' && !dualClassMtools.has(t.name)) {
        expect(t.annotations.destructiveHint ?? false, t.name).toBe(false);
      }
    }
  });
});

/* ───────────────────────────── ZodRawShape rule (§0.1) ─────────────────────────────────── */

describe('ZodRawShape (no top-level z.object, §0.1)', () => {
  it('every inputSchema/outputSchema is a plain field map, NOT a ZodObject', () => {
    for (const t of TOOL_DESCRIPTORS) {
      expect(t.inputSchema, `${t.name}.inputSchema`).not.toBeInstanceOf(ZodObject);
      expect(t.outputSchema, `${t.name}.outputSchema`).not.toBeInstanceOf(ZodObject);
      expect(typeof t.inputSchema, `${t.name}.inputSchema`).toBe('object');
      expect(typeof t.outputSchema, `${t.name}.outputSchema`).toBe('object');
    }
  });

  it('every schema field value is a zod type (z.object(rawShape) builds)', () => {
    for (const t of TOOL_DESCRIPTORS) {
      // If any field were not a ZodType, z.object(...) would throw at build time.
      expect(() => z.object(t.inputSchema), `${t.name}.inputSchema`).not.toThrow();
      expect(() => z.object(t.outputSchema), `${t.name}.outputSchema`).not.toThrow();
    }
  });
});

/* ───────────────────────────── convert options wire shape (§1.9) ───────────────────────── */

describe('convert.* options bag (§1.9 — base_url survives the SDK zod parse)', () => {
  const byName = (name: string) => {
    const t = TOOL_DESCRIPTORS.find((d) => d.name === name);
    expect(t, name).toBeDefined();
    return t!;
  };

  it('html_to_tree inputSchema keeps options.base_url (zod strips undeclared keys)', () => {
    const t = byName('elementor.convert.html_to_tree');
    const parsed = z.object(t.inputSchema).parse({
      html: '<p>x</p>',
      options: { base_url: 'https://example.com/landing/' },
    }) as { options?: { base_url?: string } };
    expect(parsed.options?.base_url).toBe('https://example.com/landing/');
  });

  it('html_to_page inputSchema carries the SAME options bag (incl. base_url)', () => {
    const t = byName('elementor.convert.html_to_page');
    expect(Object.keys(t.inputSchema)).toContain('options');
    const parsed = z.object(t.inputSchema).parse({
      html: '<p>x</p>',
      options: { base_url: 'https://example.com/landing/', sideload_media: false },
    }) as { options?: { base_url?: string; sideload_media?: boolean } };
    expect(parsed.options?.base_url).toBe('https://example.com/landing/');
    expect(parsed.options?.sideload_media).toBe(false);
  });
});

/* ───────────────────────────── pagination shape (§0.6) ─────────────────────────────────── */

const PAGINATION_INPUT_KEYS = Object.keys(paginationInputShape);
const PAGINATION_OUTPUT_KEYS = Object.keys(paginationOutputShape);

/** Tools that return a `{items,next_cursor,total}` collection (the §0.6 list/read tools). */
const LIST_TOOL_NAMES = new Set<string>([
  'elementor.pages.list',
  'elementor.page.list_backups',
  'elementor.dynamic.list_tags',
  'elementor.design.classes.list',
  'elementor.design.classes.usage',
  'elementor.design.variables.list',
  'elementor.media.list',
  'elementor.nav.menus.list',
  'elementor.templates.list',
  'elementor.pro.dynamic.list_tags',
  'elementor.ops.log',
  'elementor.tools.list_endpoints',
]);

describe('pagination (§0.6)', () => {
  it('every list tool carries the pagination input + output shape', () => {
    for (const t of TOOL_DESCRIPTORS) {
      if (!LIST_TOOL_NAMES.has(t.name)) {
        continue;
      }
      for (const key of PAGINATION_INPUT_KEYS) {
        expect(Object.keys(t.inputSchema), `${t.name} input`).toContain(key);
      }
      for (const key of PAGINATION_OUTPUT_KEYS) {
        expect(Object.keys(t.outputSchema), `${t.name} output`).toContain(key);
      }
      expect(Object.keys(t.outputSchema), `${t.name} items`).toContain('items');
    }
  });
});

/* ───────────────────────────── tool↔route coverage (§1 impl note 8) ────────────────────── */

describe('tool ↔ REST route coverage', () => {
  it('every tool `route` references a real WP-F02 route id', () => {
    const routeNames = new Set<string>(Object.keys(ROUTES));
    for (const t of TOOL_DESCRIPTORS) {
      if (t.route !== undefined) {
        expect(routeNames.has(t.route), `${t.name} -> ${t.route}`).toBe(true);
      }
    }
  });

  it('proxied-to-REST tools all declare a route id', () => {
    for (const t of TOOL_DESCRIPTORS) {
      if (t.side === 'proxied-to-REST') {
        expect(t.route, `${t.name} (proxied-to-REST must declare a route)`).toBeDefined();
      }
    }
  });

  it('the route id resolves through the typed ROUTES registry', () => {
    for (const t of TOOL_DESCRIPTORS) {
      if (t.route !== undefined) {
        const def = ROUTES[t.route];
        expect(def, t.name).toBeDefined();
      }
    }
  });
});

/* ───────────────────────────── resources + prompts (§2/§3) ─────────────────────────────── */

describe('resources (§2)', () => {
  it('every resource URI matches the elementor:// scheme + has a route + schema', () => {
    for (const r of RESOURCE_DESCRIPTORS) {
      expect(r.uri, r.uri).toMatch(RESOURCE_URI_PATTERN);
      expect(ROUTES[r.route], r.uri).toBeDefined();
      expect(Object.keys(r.outputSchema).length, r.uri).toBeGreaterThan(0);
      expect(() => z.object(r.outputSchema), r.uri).not.toThrow();
    }
  });

  it('parametric URIs are flagged as templates', () => {
    for (const r of RESOURCE_DESCRIPTORS) {
      const hasPlaceholder = /\{[^}]+\}/.test(r.uri);
      expect(r.template, r.uri).toBe(hasPlaceholder);
    }
  });
});

describe('prompts (§3)', () => {
  it('every prompt has a string-arg ZodRawShape', () => {
    for (const p of PROMPT_DESCRIPTORS) {
      expect(p.argsSchema).not.toBeInstanceOf(ZodObject);
      expect(() => z.object(p.argsSchema), p.name).not.toThrow();
    }
  });
});

/* ───────────────────────────── zod ↔ JSON Schema agreement (§Tests) ────────────────────── */

interface JsonDef {
  required?: string[];
  properties?: Record<string, unknown>;
}
// Read the frozen WP-F03 JSON Schema from the shared package's `schemas/` dir (not a package export —
// the agreement test reads the canonical file directly so zod ↔ JSON-Schema drift fails CI).
const DIFF_JSON_SCHEMA_PATH = new URL('../../../shared/schemas/diff.schema.json', import.meta.url);
const diffJsonSchema = JSON.parse(readFileSync(DIFF_JSON_SCHEMA_PATH, 'utf8')) as {
  $defs: Record<string, JsonDef>;
};
function jsonDef(name: string): JsonDef {
  const def = diffJsonSchema.$defs[name];
  if (def === undefined) {
    throw new Error(`Missing $def "${name}" in diff.schema.json`);
  }
  return def;
}

/** Required keys of a zod object = keys whose schema is not optional. */
function zodRequiredKeys(shape: z.ZodRawShape): Set<string> {
  const required = new Set<string>();
  for (const [key, schema] of Object.entries(shape)) {
    if (!schema.isOptional()) {
      required.add(key);
    }
  }
  return required;
}

describe('zod ↔ JSON Schema agreement (Diff / DryRunResult / CoverageReport)', () => {
  it('Diff required keys agree', () => {
    const jsonReq = new Set(jsonDef('Diff').required ?? []);
    const zodReq = zodRequiredKeys(diffSchema.shape);
    expect(zodReq).toEqual(jsonReq);
  });

  it('ValidationError required keys agree', () => {
    const jsonReq = new Set(jsonDef('ValidationError').required ?? []);
    const zodReq = zodRequiredKeys(validationErrorSchema.shape);
    expect(zodReq).toEqual(jsonReq);
  });

  it('CoverageReport required keys agree (none required)', () => {
    const jsonReq = new Set(jsonDef('CoverageReport').required ?? []);
    const zodReq = zodRequiredKeys(coverageReportSchema.shape);
    expect(zodReq).toEqual(jsonReq);
  });

  it('DryRunResult `valid` is required in both the JSON Schema type + the page.dry_run tool output', () => {
    expect(new Set(jsonDef('DryRunResult').required ?? [])).toEqual(new Set(['valid']));
    // The tool wire shape (§1.2) always returns `valid` + `errors`; assert `valid` present + required.
    expect(Object.keys(pageDryRunOutput)).toContain('valid');
    expect(pageDryRunOutput.valid.isOptional()).toBe(false);
    // `errors[]` items use the nullable id/prop shape of §1.2 (distinct from the WP-F03 ValidationError).
    expect(new Set(zodRequiredKeys(dryRunErrorSchema.shape))).toEqual(
      new Set(['element_id', 'style_id', 'prop', 'code', 'message']),
    );
  });
});

/* ───────────────────────────── PHP wire-shape tolerance (seamless-audit) ────────────────── */

describe('pagination limit cap (§0.6 vs REST §0.11 drift, #18)', () => {
  it('limit max matches the PHP REST cap (100) so every schema-legal call is REST-legal', () => {
    expect(paginationInputShape.limit.safeParse(1).success).toBe(true);
    expect(paginationInputShape.limit.safeParse(100).success).toBe(true);
    expect(paginationInputShape.limit.safeParse(101).success).toBe(false);
    expect(paginationInputShape.limit.safeParse(200).success).toBe(false);
  });
});

describe('elementNodeSchema tolerates PHP serialization quirks (#37)', () => {
  it('accepts `settings: []` (PHP json_encode of an empty assoc map) and normalizes it to {}', () => {
    const parsed = elementNodeSchema.safeParse({
      id: 'abc1234',
      elType: 'widget',
      widgetType: 'heading',
      settings: [],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as { settings?: unknown }).settings).toEqual({});
    }
  });

  it('accepts an ABSENT `settings` key (PHP validates it as optional) and defaults it to {}', () => {
    const parsed = elementNodeSchema.safeParse({ id: 'abc1234', elType: 'container' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as { settings?: unknown }).settings).toEqual({});
    }
  });

  it('still rejects a NON-empty array `settings` payload', () => {
    expect(
      elementNodeSchema.safeParse({ id: 'abc1234', elType: 'widget', settings: [1] }).success,
    ).toBe(false);
  });

  it('accepts `widgetType: null` (PHP `projection=summary` emits null on containers)', () => {
    const parsed = elementNodeSchema.safeParse({
      id: 'abc1234',
      elType: 'e-flexbox',
      widgetType: null,
      settings: {},
    });
    expect(parsed.success).toBe(true);
  });

  it('nested children carrying `settings: []` validate (round-tripped classic v3 trees)', () => {
    const tree = {
      id: 'aaaa111',
      elType: 'container',
      settings: {},
      elements: [{ id: 'bbbb222', elType: 'widget', widgetType: 'text-editor', settings: [] }],
    };
    expect(elementNodeSchema.safeParse(tree).success).toBe(true);
  });
});

describe('pageSettingsSchema tolerates PHP empty-assoc serialization (#3b)', () => {
  it('accepts `[]` and normalizes it to {}', () => {
    const parsed = pageSettingsSchema.safeParse([]);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({});
    }
  });

  it('templates.get `page_settings` (PHP emits [] when empty) validates', () => {
    expect(templatesGetOutput.page_settings.safeParse([]).success).toBe(true);
    expect(templatesGetOutput.page_settings.safeParse({ hide_title: 'yes' }).success).toBe(true);
  });
});

describe('pageSettingsInputSchema — §7-AI S1 document-settings allowlist (contract 18)', () => {
  it('REJECTS the AF1 fatal shape: an object custom_css on page settings', () => {
    const parsed = pageSettingsInputSchema.safeParse({
      custom_css: { $$type: 'string', value: 'Ym9keXt9' },
    });
    expect(parsed.success).toBe(false);
  });

  it('REJECTS an array custom_css', () => {
    expect(pageSettingsInputSchema.safeParse({ custom_css: ['body{}'] }).success).toBe(false);
  });

  it('accepts a plain-string custom_css (the page-settings form)', () => {
    expect(pageSettingsInputSchema.safeParse({ custom_css: 'body { margin: 0; }' }).success).toBe(
      true,
    );
  });

  it('enforces the template enum (incl. elementor_canvas)', () => {
    expect(pageSettingsInputSchema.safeParse({ template: 'elementor_canvas' }).success).toBe(true);
    expect(pageSettingsInputSchema.safeParse({ template: 'default' }).success).toBe(true);
    expect(pageSettingsInputSchema.safeParse({ template: 'twentytwenty.php' }).success).toBe(false);
    expect(pageSettingsInputSchema.safeParse({ template: 7 }).success).toBe(false);
  });

  it('hide_title accepts boolean + the legacy switcher strings, rejects other shapes', () => {
    expect(pageSettingsInputSchema.safeParse({ hide_title: true }).success).toBe(true);
    expect(pageSettingsInputSchema.safeParse({ hide_title: 'yes' }).success).toBe(true);
    expect(pageSettingsInputSchema.safeParse({ hide_title: '' }).success).toBe(true);
    expect(pageSettingsInputSchema.safeParse({ hide_title: { on: true } }).success).toBe(false);
  });

  it('enforces the post_status enum', () => {
    expect(pageSettingsInputSchema.safeParse({ post_status: 'publish' }).success).toBe(true);
    expect(pageSettingsInputSchema.safeParse({ post_status: 'banana' }).success).toBe(false);
  });

  it('UNKNOWN keys pass through verbatim (the bag stays open)', () => {
    const parsed = pageSettingsInputSchema.safeParse({
      background_background: 'classic',
      some_future_key: { nested: true },
    });
    expect(parsed.success).toBe(true);
  });

  it('tolerates the PHP empty-assoc `[]` serialization like the permissive schema', () => {
    const parsed = pageSettingsInputSchema.safeParse([]);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({});
    }
  });
});

describe('ops.log output tolerates real op-log rows (#0)', () => {
  it('accepts `op_id: null` (PHP table column is `DEFAULT NULL`)', () => {
    const row = {
      op_id: null,
      post_id: null,
      user: 'admin',
      tool: 'documents/save',
      before_hash: '',
      after_hash: '',
      result: 'ok',
      ts: '1781045222',
    };
    expect(opsLogOutput.items.element.safeParse(row).success).toBe(true);
  });
});

describe('fields-projection tolerance on §0.6 list items (output -32602 class fix)', () => {
  it('fieldProjectedItem keeps types strict but makes every property optional', () => {
    const projected = fieldProjectedItem(z.object({ a: z.string(), b: z.number().int() }));
    expect(projected.safeParse({}).success).toBe(true);
    expect(projected.safeParse({ a: 'x' }).success).toBe(true);
    expect(projected.safeParse({ a: 1 }).success).toBe(false);
  });

  it('templates.list items tolerate a `fields`-projected subset', () => {
    expect(templatesListOutput.items.element.safeParse({ title: 'Landing' }).success).toBe(true);
  });

  it('EVERY list tool item property is optional (a projected-away field is simply absent)', () => {
    for (const t of TOOL_DESCRIPTORS) {
      if (!LIST_TOOL_NAMES.has(t.name)) {
        continue;
      }
      const items = (t.outputSchema as Record<string, z.ZodTypeAny>)[
        'items'
      ] as z.ZodArray<z.ZodTypeAny>;
      const element = items.element;
      expect(element, `${t.name} items.element`).toBeInstanceOf(ZodObject);
      for (const [key, field] of Object.entries((element as ZodObject<z.ZodRawShape>).shape)) {
        expect(field.isOptional(), `${t.name} item.${key}`).toBe(true);
      }
    }
  });
});
