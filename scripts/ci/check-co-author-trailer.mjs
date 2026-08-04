#!/usr/bin/env node
/**
 * WP-F07 — commit hygiene guard (`15-engineering-standards.md §5.3` + `§5.6`).
 *
 * Asserts every commit on the PR branch carries:
 *   1. the REQUIRED co-author trailer
 *        `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`   (§5.6), AND
 *   2. a Conventional-Commit subject with a `wp-<id>` scope, e.g.
 *        `feat(wp-t03): ...`, `fix(wp-p02): ...`, `test(wp-q01): ...`, `chore(wp-f07): ...`   (§5.3).
 *
 * ADVISORY BY DEFAULT (the ticket: "Advisory unless toggled required"): violations are reported and
 * the script exits 0 so it does not block merges. Set `CO_AUTHOR_REQUIRED=1` (or pass `--required`)
 * to make it a hard gate (exit 1). The CI step runs it with `continue-on-error: true` as a second
 * layer of advisory safety.
 *
 * Commit range:
 *   - In a GitHub PR: `${BASE_SHA}..${HEAD_SHA}` (the workflow passes `--base`/`--head`, falling back
 *     to `GITHUB_BASE_REF`/`GITHUB_SHA`).
 *   - Locally: defaults to `origin/main..HEAD` (or `--range <a>..<b>`).
 *
 * Pure Node + `git` (no npm deps).
 */

import { execFileSync } from 'node:child_process';

export const CO_AUTHOR_TRAILER =
  'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>';

/** Conventional-Commit subject with a `wp-<id>` scope. Type list per `§5.3` (+ common CC types). */
export const SUBJECT_RE =
  /^(feat|fix|test|chore|docs|refactor|perf|build|ci|style|revert)\(wp-[a-z]?\d{2,}[a-z0-9-]*\)(!)?:\s.+/;

const SEP = 'COMMIT';

function getArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

/** Resolve the `<base>..<head>` range from CLI args / GitHub env. */
function resolveRange() {
  const explicit = getArg('--range');
  if (explicit) return explicit;
  const base = getArg('--base', process.env.GITHUB_BASE_REF);
  const head = getArg('--head', process.env.GITHUB_SHA || 'HEAD');
  if (base) return `${base}..${head}`;
  return 'origin/main..HEAD';
}

/** Read raw commit bodies (subject + trailers) for a range, split on a private separator. */
export function readCommits(range) {
  let raw = '';
  try {
    raw = execFileSync('git', ['log', `--format=%B${SEP}`, range], { encoding: 'utf8' });
  } catch (err) {
    // No history / unknown range: nothing to check (advisory).
    console.warn(`check-co-author-trailer: could not read git range "${range}": ${err.message}`);
    return [];
  }
  return raw
    .split(SEP)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Validate one commit message body.
 * @param {string} body full commit message (subject + body + trailers)
 * @returns {{ subjectOk: boolean, trailerOk: boolean, subject: string }}
 */
export function validateCommit(body) {
  const subject = (body.split('\n')[0] ?? '').trim();
  const subjectOk = SUBJECT_RE.test(subject);
  // Trailer match is whitespace-tolerant on the line but exact on the identity string.
  const trailerOk = body
    .split('\n')
    .some((line) => line.trim().toLowerCase() === CO_AUTHOR_TRAILER.toLowerCase());
  return { subjectOk, trailerOk, subject };
}

function main() {
  const required = process.argv.includes('--required') || process.env.CO_AUTHOR_REQUIRED === '1';
  const range = resolveRange();
  const commits = readCommits(range);

  if (commits.length === 0) {
    console.log(`check-co-author-trailer: no commits in range "${range}" — nothing to check.`);
    return;
  }

  const problems = [];
  for (const body of commits) {
    const { subjectOk, trailerOk, subject } = validateCommit(body);
    if (!subjectOk) {
      problems.push(`Subject is not a Conventional-Commit with a wp-<id> scope: "${subject}"`);
    }
    if (!trailerOk) {
      problems.push(`Missing co-author trailer on commit: "${subject}"`);
    }
  }

  if (problems.length > 0) {
    const head = `check-co-author-trailer: ${problems.length} issue(s) in range "${range}":`;
    if (required) {
      console.error(head);
      for (const p of problems) console.error(`  - ${p}`);
      console.error('\nRequired mode (CO_AUTHOR_REQUIRED=1) — failing.');
      console.error(`Expected trailer: ${CO_AUTHOR_TRAILER}`);
      process.exit(1);
    }
    console.warn(head);
    for (const p of problems) console.warn(`  - ${p}`);
    console.warn('\nAdvisory mode — not failing. Set CO_AUTHOR_REQUIRED=1 to enforce.');
    return;
  }

  console.log(
    `check-co-author-trailer: OK — all ${commits.length} commit(s) in "${range}" carry the co-author trailer and a wp-<id> Conventional-Commit scope.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
