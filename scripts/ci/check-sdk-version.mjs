#!/usr/bin/env node
/**
 * WP-F07 — MCP SDK 2.x trap guard (`15-engineering-standards.md §1` "MCP SDK pin", `§7`).
 *
 * The pin is LOCKED at `@modelcontextprotocol/sdk@^1.29` and NEVER any `2.x` `@modelcontextprotocol/*`
 * package. In 1.x, `inputSchema`/`outputSchema` are ZodRawShape maps and transports are deep `.js`
 * imports (RESEARCH.md §3.2); a 2.x bump silently breaks the whole tool/transport surface. This guard
 * parses the committed `pnpm-lock.yaml` and FAILS (exit 1) if EITHER:
 *
 *   1. ANY `@modelcontextprotocol/*` package resolves to a `2.x` (or higher major) version anywhere in
 *      the lockfile (`packages:` keys + every `importers:` `version:` field), OR
 *   2. the `@modelcontextprotocol/sdk` declared specifier is not satisfied by `^1.29` (i.e. the pin in
 *      `packages/server/package.json` drifted off `^1.29`).
 *
 * It is invoked in CI Stage 1 (`ci.yml`) and as a release gate (`release.yml`), per the ticket.
 *
 * Pure Node — no npm deps (the lockfile is parsed line-oriented; pnpm lockfiles are structurally
 * regular). The lockfile is NOT trusted as YAML-by-a-parser on purpose so this guard has zero install
 * dependency and runs before `pnpm install` if needed.
 *
 * Usage:
 *   node scripts/ci/check-sdk-version.mjs              # check the repo lockfile (exit 1 on violation)
 *   node scripts/ci/check-sdk-version.mjs --self-test  # run the embedded unit fixtures (Tests Required)
 *   node scripts/ci/check-sdk-version.mjs <lockfile>   # check an explicit lockfile path
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

/** The required SDK pin (`15-engineering-standards.md §1/§7`). */
export const SDK_PACKAGE = '@modelcontextprotocol/sdk';
export const SDK_REQUIRED_RANGE = '^1.29';
export const SDK_REQUIRED_MAJOR = 1;
export const SDK_REQUIRED_MINOR = 29;

/**
 * Extract every `@modelcontextprotocol/*` package and its resolved version from a pnpm lockfile body.
 *
 * Two surfaces are scanned so a transitive 2.x cannot sneak past a clean top-level pin:
 *   - `packages:` (and the legacy `snapshots:`) section keys, of the form
 *     `'@modelcontextprotocol/sdk@1.29.0':` or `'@modelcontextprotocol/sdk@1.29.0(zod@3.25.76)':`.
 *   - `importers:` blocks, where a dependency carries `version: 1.29.0(zod@3.25.76)` two lines under
 *     its `'@modelcontextprotocol/...':` key (and `specifier: ^1.29` directly under it).
 *
 * @param {string} lock raw lockfile text
 * @returns {{ name: string, version: string, source: string }[]}
 */
export function extractMcpPackages(lock) {
  const out = [];
  const lines = lock.split('\n');

  // (1) package / snapshot section keys: `'<name>@<version>(...)':` or `<name>@<version>:`
  const keyRe = /^\s+'?(@modelcontextprotocol\/[^@'\s]+)@([^':()\s]+)/;
  for (const line of lines) {
    const m = keyRe.exec(line);
    if (m) out.push({ name: m[1], version: m[2], source: 'packages' });
  }

  // (2) importers blocks: a `'<name>':` key followed by indented `specifier:` / `version:` lines.
  for (let i = 0; i < lines.length; i++) {
    const keyM = /^\s+'?(@modelcontextprotocol\/[^@'\s:]+)'?:\s*$/.exec(lines[i] ?? '');
    if (!keyM) continue;
    // Look ahead a few lines for `version:` (and tolerate `specifier:` first).
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const vm = /^\s+version:\s+'?([^'()\s]+)/.exec(lines[j] ?? '');
      if (vm) {
        out.push({ name: keyM[1], version: vm[1], source: 'importers' });
        break;
      }
      // Stop if the next sibling key starts (dedented back to a key without version).
      if (
        /^\s+'?[^'\s:]+'?:\s*$/.test(lines[j] ?? '') &&
        !/specifier:|version:/.test(lines[j] ?? '')
      ) {
        break;
      }
    }
  }

  return out;
}

/** Extract the declared `@modelcontextprotocol/sdk` specifier(s) from a lockfile's importers. */
export function extractSdkSpecifiers(lock) {
  const out = [];
  const lines = lock.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const keyM = /^\s+'?@modelcontextprotocol\/sdk'?:\s*$/.exec(lines[i] ?? '');
    if (!keyM) continue;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const sm = /^\s+specifier:\s+'?([^'\s]+)'?/.exec(lines[j] ?? '');
      if (sm) {
        out.push(sm[1]);
        break;
      }
    }
  }
  return out;
}

/** Parse a `major.minor.patch...` version into `[major, minor]` integers (best-effort). */
export function majorMinor(version) {
  const cleaned = String(version).replace(/^[v^~>=<\s]+/, '');
  const [maj, min] = cleaned.split('.', 2);
  return [Number.parseInt(maj, 10) || 0, Number.parseInt(min, 10) || 0];
}

/**
 * Core analysis: given lockfile text, return the list of violations (empty = clean).
 * @param {string} lock
 * @returns {string[]} human-readable violation messages
 */
export function analyzeLockfile(lock) {
  const violations = [];

  // Rule 1 — no 2.x (or higher) anywhere in the @modelcontextprotocol scope.
  const pkgs = extractMcpPackages(lock);
  const seen = new Set();
  for (const { name, version } of pkgs) {
    const dedupeKey = `${name}@${version}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const [maj] = majorMinor(version);
    if (maj >= 2) {
      violations.push(
        `Forbidden MCP SDK major: ${name}@${version} (>=2.x). The pin is LOCKED at ${SDK_REQUIRED_RANGE} ` +
          `(15-engineering-standards.md §1/§7). A 2.x package breaks the ZodRawShape tool surface and ` +
          `deep transport imports.`,
      );
    }
  }

  // Rule 2 — the declared sdk specifier must be satisfied by ^1.29 (i.e. be `^1.x` with x>=29, or any
  // explicit 1.y where y>=29). We check the declared specifier strings AND the resolved sdk version.
  const specs = extractSdkSpecifiers(lock);
  for (const spec of specs) {
    const [maj, min] = majorMinor(spec);
    const looksCaret = /^[\^~]?1\./.test(spec.replace(/^[v\s]+/, ''));
    if (!looksCaret || maj !== SDK_REQUIRED_MAJOR || min < SDK_REQUIRED_MINOR) {
      violations.push(
        `${SDK_PACKAGE} specifier "${spec}" does not satisfy the required pin ${SDK_REQUIRED_RANGE} ` +
          `(15-engineering-standards.md §7).`,
      );
    }
  }

  // Also assert the RESOLVED sdk version is 1.x (>=1.29); a resolved 2.x is already caught by Rule 1,
  // but a resolved 1.28 (below the floor) would slip Rule 1, so verify the floor here too.
  for (const { name, version } of pkgs) {
    if (name !== SDK_PACKAGE) continue;
    const [maj, min] = majorMinor(version);
    if (maj === SDK_REQUIRED_MAJOR && min < SDK_REQUIRED_MINOR) {
      violations.push(
        `${SDK_PACKAGE} resolved to ${version}, below the required floor ${SDK_REQUIRED_RANGE} ` +
          `(15-engineering-standards.md §7).`,
      );
    }
  }

  return [...new Set(violations)];
}

/** The embedded unit fixtures (Tests Required: "a clean one passes, a 2.x one fails"). */
function selfTest() {
  const cases = [
    {
      name: 'clean ^1.29 lockfile passes',
      lock: [
        'importers:',
        '  packages/server:',
        '    dependencies:',
        "      '@modelcontextprotocol/sdk':",
        '        specifier: ^1.29',
        '        version: 1.29.0(zod@3.25.76)',
        'packages:',
        "  '@modelcontextprotocol/sdk@1.29.0':",
        '    resolution: {integrity: sha512-abc}',
      ].join('\n'),
      expectClean: true,
    },
    {
      name: '2.x sdk fails (Rule 1)',
      lock: [
        'importers:',
        '  packages/server:',
        '    dependencies:',
        "      '@modelcontextprotocol/sdk':",
        '        specifier: ^2.0.0',
        '        version: 2.0.0',
        'packages:',
        "  '@modelcontextprotocol/sdk@2.0.0':",
        '    resolution: {integrity: sha512-abc}',
      ].join('\n'),
      expectClean: false,
    },
    {
      name: 'transitive @modelcontextprotocol 2.x fails',
      lock: [
        'packages:',
        "  '@modelcontextprotocol/sdk@1.29.0':",
        '    resolution: {integrity: sha512-abc}',
        "  '@modelcontextprotocol/server@2.0.0-alpha':",
        '    resolution: {integrity: sha512-def}',
      ].join('\n'),
      expectClean: false,
    },
    {
      name: 'below-floor 1.28 sdk fails (Rule 2 floor)',
      lock: [
        'importers:',
        '  packages/server:',
        '    dependencies:',
        "      '@modelcontextprotocol/sdk':",
        '        specifier: ^1.28',
        '        version: 1.28.0',
        'packages:',
        "  '@modelcontextprotocol/sdk@1.28.0':",
        '    resolution: {integrity: sha512-abc}',
      ].join('\n'),
      expectClean: false,
    },
    {
      name: 'scoped version with peer-dep suffix is parsed',
      lock: [
        'packages:',
        "  '@modelcontextprotocol/sdk@2.1.0(zod@3.25.76)':",
        '    resolution: {}',
      ].join('\n'),
      expectClean: false,
    },
  ];

  let failures = 0;
  for (const c of cases) {
    const violations = analyzeLockfile(c.lock);
    const clean = violations.length === 0;
    const ok = clean === c.expectClean;
    if (!ok) {
      failures++;
      console.error(`  ✗ ${c.name} — expected ${c.expectClean ? 'clean' : 'violations'}, got:`);
      console.error(`    ${violations.length ? violations.join('\n    ') : '(clean)'}`);
    } else {
      console.log(`  ✓ ${c.name}`);
    }
  }
  if (failures > 0) {
    console.error(`\ncheck-sdk-version self-test: ${failures} case(s) FAILED.`);
    process.exit(1);
  }
  console.log('\ncheck-sdk-version self-test: all cases passed.');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    selfTest();
    return;
  }

  const lockArg = args.find((a) => !a.startsWith('--'));
  const lockPath = lockArg ? resolve(process.cwd(), lockArg) : resolve(ROOT, 'pnpm-lock.yaml');
  if (!existsSync(lockPath)) {
    console.error(`check-sdk-version: lockfile not found at ${lockPath}`);
    process.exit(1);
  }

  const lock = readFileSync(lockPath, 'utf8');
  const violations = analyzeLockfile(lock);
  if (violations.length > 0) {
    console.error('check-sdk-version: MCP SDK pin guard FAILED:');
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }

  const pkgs = extractMcpPackages(lock).filter((p) => p.name === SDK_PACKAGE);
  const resolved = pkgs.length ? pkgs[0].version : '(not found in lockfile)';
  console.log(
    `check-sdk-version: OK — ${SDK_PACKAGE} pinned to ${SDK_REQUIRED_RANGE} (resolved ${resolved}); no @modelcontextprotocol 2.x present.`,
  );
}

// Only run when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
