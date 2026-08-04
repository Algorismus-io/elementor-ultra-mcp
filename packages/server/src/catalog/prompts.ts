/**
 * WP-F04 — the FROZEN MCP prompt catalog (13-tool-catalog.md §3).
 *
 * Prompts register via `server.registerPrompt(name, { title, description, argsSchema }, handler)`.
 * `argsSchema` is a ZodRawShape of STRING args (MCP prompt args are strings, §3). This module is pure
 * data — the live `McpServer` prompt registration + the handler bodies are WP-T01's / the prompt WP's.
 */

import { z } from 'zod';

/* ───────────────────────────── descriptor type ─────────────────────────────────────────── */

/** A single frozen prompt descriptor (13-tool-catalog.md §3). */
export interface PromptDescriptor {
  name: string;
  title: string;
  description: string;
  /** ZodRawShape of STRING args (MCP prompt args are strings, §3). */
  argsSchema: z.ZodRawShape;
}

/* ───────────────────────────── the prompt catalog (§3) ──────────────────────────────────── */

/** EVERY prompt in 13-tool-catalog.md §3, in order. */
export const PROMPT_DESCRIPTORS: readonly PromptDescriptor[] = [
  {
    name: 'build-from-brief',
    title: 'Build a page from a brief',
    description:
      'Guide the agent to turn a natural-language brief into a validated `page.build` call (probe capabilities, choose V4/V3, dry-run, prime CSS).',
    argsSchema: {
      brief: z.string(),
      post_type: z.string().optional(),
      generation: z.string().optional(),
    },
  },
  {
    name: 'html-to-native',
    title: 'Convert HTML to native Elementor',
    description:
      'Drive `convert.html_to_tree` → review report → confirm → `convert.html_to_page` with explicit commit. NEVER auto-commit.',
    argsSchema: {
      html: z.string(),
      css: z.string().optional(),
      coverage_gate: z.string().optional(),
    },
  },
  {
    name: 'design-system-audit',
    title: 'Audit the design system',
    description:
      'Read classes + variables + V3 globals, report duplication/budget/coverage, and propose consolidating `design.classes.upsert`/`variables.batch` operations.',
    argsSchema: {
      scope: z.string().optional(),
    },
  },
  {
    name: 'theme-builder-from-spec',
    title: 'Build a theme-builder template from a spec',
    description:
      'Create header/footer/single/archive/popup docs and attach correct display conditions via `pro.theme.*`/`pro.popup.*`.',
    argsSchema: {
      spec: z.string(),
      theme_type: z.string().optional(),
    },
  },
] as const;

/** Frozen list of all prompt names. */
export const PROMPT_NAMES: readonly string[] = PROMPT_DESCRIPTORS.map((p) => p.name);

/** Total prompt count in the frozen catalog. */
export const PROMPT_COUNT: number = PROMPT_DESCRIPTORS.length;
