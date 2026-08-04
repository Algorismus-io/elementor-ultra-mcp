/**
 * WP-R11 — `dynamic-encoder.ts` unit + cross-runtime PARITY tests (§Tests Required).
 *
 * Vitest, no live WordPress. Asserts the TS encoder reproduces core `Manager::tag_to_text()`
 * byte-for-byte (SUPPLEMENT.md §A.6):
 *  - the 3 worked §A.6 strings (post-title `%7B%7D`, post-featured-image nested object, acf-text composite key);
 *  - empty settings → `%7B%7D` (NEVER empty string, the #1 gotcha);
 *  - PHP-faithful slash/non-ASCII escaping (`\/`, lowercase `\uXXXX`) and `urlencode` safe-set
 *    (`~ ( ) * ! ' +` percent-encoded; space → `+`);
 *  - JSON_FORCE_OBJECT array→object behavior (`[]`→`%7B%7D`);
 *  - the CROSS-RUNTIME PARITY loop: every row of the WP-R05-owned oracle fixture
 *    `packages/shared/fixtures/trees/pro/dynamic.encodings.json` matches the TS output. This is the
 *    contract guaranteeing "TS preview == PHP write".
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  encodeDynamicTag,
  wpJsonEncode,
  phpUrlEncode,
  generateTagId,
  TAG_LABEL,
} from './dynamic-encoder.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Absolute path to `packages/shared/fixtures` (resolved relative to this module). */
const FIXTURES_DIR = resolve(HERE, '..', '..', '..', 'shared', 'fixtures');

/** A single oracle row from the WP-R05 cross-runtime fixture. */
interface EncodingRow {
  name: string;
  tag: string;
  settings: Record<string, unknown>;
  id: string;
  expected_string: string;
}

interface EncodingFixture {
  rows: EncodingRow[];
}

/* ───────────────────────────── the 3 worked §A.6 strings (Acceptance) ──────────────────────── */

describe('encodeDynamicTag — SUPPLEMENT.md §A.6 worked strings', () => {
  it('post-title (no settings) → %7B%7D', () => {
    expect(encodeDynamicTag('post-title', {}, 'a1b2c3d')).toBe(
      '[elementor-tag id="a1b2c3d" name="post-title" settings="%7B%7D"]',
    );
  });

  it('post-featured-image (nested object {fallback:{id,url}})', () => {
    expect(
      encodeDynamicTag('post-featured-image', { fallback: { id: '', url: '' } }, 'b2c3d4e'),
    ).toBe(
      '[elementor-tag id="b2c3d4e" name="post-featured-image" settings="%7B%22fallback%22%3A%7B%22id%22%3A%22%22%2C%22url%22%3A%22%22%7D%7D"]',
    );
  });

  it('acf-text (composite key, colon → %3A)', () => {
    expect(encodeDynamicTag('acf-text', { key: 'field_5f3a1b2c:project_client' }, 'c3d4e5f')).toBe(
      '[elementor-tag id="c3d4e5f" name="acf-text" settings="%7B%22key%22%3A%22field_5f3a1b2c%3Aproject_client%22%7D"]',
    );
  });
});

/* ───────────────────────────── empty-settings gotcha (Acceptance) ──────────────────────────── */

describe('encodeDynamicTag — empty settings gotcha', () => {
  it('empty object → settings="%7B%7D", NEVER empty string', () => {
    const out = encodeDynamicTag('site-title', {}, 'd4e5f6g');
    expect(out).toBe('[elementor-tag id="d4e5f6g" name="site-title" settings="%7B%7D"]');
    expect(out).not.toContain('settings=""');
  });

  it('defaults to {} when settings omitted → %7B%7D', () => {
    expect(encodeDynamicTag('post-title', undefined, 'a1b2c3d')).toBe(
      '[elementor-tag id="a1b2c3d" name="post-title" settings="%7B%7D"]',
    );
  });

  it('a nested empty array encodes as %7B%7D (JSON_FORCE_OBJECT)', () => {
    // PHP `wp_json_encode(["a"=>[]], JSON_FORCE_OBJECT)` => `{"a":{}}`.
    expect(wpJsonEncode({ a: [] })).toBe('{"a":{}}');
  });
});

/* ───────────────────────────── wpJsonEncode — PHP default-flag fidelity ────────────────────── */

describe('wpJsonEncode — byte parity with wp_json_encode($s, JSON_FORCE_OBJECT)', () => {
  it('empty object → {}', () => {
    expect(wpJsonEncode({})).toBe('{}');
  });

  it('escapes forward slashes as \\/ (PHP default)', () => {
    // verified: wp_json_encode(["slashy"=>"a/b/c"]) => {"slashy":"a\/b\/c"}
    expect(wpJsonEncode({ slashy: 'a/b/c' })).toBe('{"slashy":"a\\/b\\/c"}');
  });

  it('escapes non-ASCII to lowercase \\uXXXX (PHP default)', () => {
    // verified: wp_json_encode(["uni"=>"café"]) => {"uni":"café"}
    expect(wpJsonEncode({ uni: 'café' })).toBe('{"uni":"caf\\u00e9"}');
  });

  it('emits a surrogate pair for an astral char (matches PHP per-UTF-16-unit)', () => {
    // verified: wp_json_encode(["emoji"=>"x😀y"]) => {"emoji":"x😀y"}
    expect(wpJsonEncode({ emoji: 'x😀y' })).toBe('{"emoji":"x\\ud83d\\ude00y"}');
  });

  it('leaves < > & literal (PHP default does NOT set JSON_HEX_*)', () => {
    expect(wpJsonEncode({ lt: '<a>', amp: 'a&b' })).toBe('{"lt":"<a>","amp":"a&b"}');
  });

  it('converts indexed arrays to objects (JSON_FORCE_OBJECT)', () => {
    // verified: wp_json_encode(["a"=>[1,2]], JSON_FORCE_OBJECT) => {"a":{"0":1,"1":2}}
    expect(wpJsonEncode({ a: [1, 2] })).toBe('{"a":{"0":1,"1":2}}');
  });

  it('preserves key insertion order and scalar/number types', () => {
    expect(wpJsonEncode({ max_length: 25, apply_to_post_content: 'no' })).toBe(
      '{"max_length":25,"apply_to_post_content":"no"}',
    );
  });
});

/* ───────────────────────────── phpUrlEncode — RFC1738 safe set ─────────────────────────────── */

describe('phpUrlEncode — byte parity with PHP urlencode()', () => {
  it('keeps A-Za-z0-9-_. unescaped', () => {
    expect(phpUrlEncode('Abc-123_x.y')).toBe('Abc-123_x.y');
  });

  it('encodes space as + (NOT %20)', () => {
    expect(phpUrlEncode('a b')).toBe('a+b');
  });

  it("percent-encodes the chars encodeURIComponent would skip: ~ ( ) * ! '", () => {
    // verified: urlencode for these → %7E %28 %29 %2A %21 %27 ; '+' literal → %2B
    expect(phpUrlEncode('~')).toBe('%7E');
    expect(phpUrlEncode('(')).toBe('%28');
    expect(phpUrlEncode(')')).toBe('%29');
    expect(phpUrlEncode('*')).toBe('%2A');
    expect(phpUrlEncode('!')).toBe('%21');
    expect(phpUrlEncode("'")).toBe('%27');
    expect(phpUrlEncode('+')).toBe('%2B');
  });

  it('uses UPPERCASE hex and encodes { } " : , as the §A.6 examples do', () => {
    expect(phpUrlEncode('{}')).toBe('%7B%7D');
    expect(phpUrlEncode('"')).toBe('%22');
    expect(phpUrlEncode(':')).toBe('%3A');
    expect(phpUrlEncode(',')).toBe('%2C');
  });
});

/* ───────────────────────────── generateTagId + TAG_LABEL ───────────────────────────────────── */

describe('generateTagId / TAG_LABEL', () => {
  it('TAG_LABEL is the core constant elementor-tag', () => {
    expect(TAG_LABEL).toBe('elementor-tag');
  });

  it('mints a 7-char lowercase-alphanumeric id', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateTagId()).toMatch(/^[a-z0-9]{7}$/);
    }
  });

  it('default id makes encodeDynamicTag non-deterministic but well-formed', () => {
    const out = encodeDynamicTag('post-title', {});
    expect(out).toMatch(/^\[elementor-tag id="[a-z0-9]{7}" name="post-title" settings="%7B%7D"\]$/);
  });
});

/* ───────────────────────────── CROSS-RUNTIME PARITY (the contract) ─────────────────────────── */

describe('cross-runtime parity vs WP-R05 dynamic.encodings.json oracle', () => {
  const fixturePath = join(FIXTURES_DIR, 'trees', 'pro', 'dynamic.encodings.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as EncodingFixture;

  it('loads at least the §A.6 rows from the oracle fixture', () => {
    expect(Array.isArray(fixture.rows)).toBe(true);
    expect(fixture.rows.length).toBeGreaterThanOrEqual(3);
  });

  it.each(fixture.rows.map((r) => [r.name, r] as const))(
    'TS encoder matches PHP byte-for-byte: %s',
    (_name, row) => {
      expect(encodeDynamicTag(row.tag, row.settings, row.id)).toBe(row.expected_string);
    },
  );
});
