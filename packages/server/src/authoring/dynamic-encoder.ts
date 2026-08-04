/**
 * WP-R11 — the shared TS dynamic-tag SHORTCODE ENCODER (`encodeDynamicTag`), a byte-for-byte mirror of
 * Elementor core `Manager::tag_to_text()` (`elementor/core/dynamic-tags/manager.php:141-142`,
 * SUPPLEMENT.md §A.6).
 *
 * The authoritative dynamic write happens SERVER-SIDE (WP-R05 `POST /pro/dynamic/bind`, which re-encodes
 * + validates `control.dynamic.active`/category intersection); this TS encoder is a CLIENT-SIDE
 * pre-filter/preview reused by the Pro `elementor.pro.dynamic.bind` tool, `elementor.element.bind_dynamic`,
 * and the HTML → page pipeline for dynamic-bound text. It lives in `authoring/` (NOT `tools/pro/`) so
 * non-Pro callers can reuse it. Its output MUST agree with the PHP encoder; the cross-runtime parity is
 * locked by the shared oracle fixture `packages/shared/fixtures/trees/pro/dynamic.encodings.json` (OWNED
 * by WP-R05, asserted byte-for-byte by `dynamic-encoder.test.ts`).
 *
 * The PHP shape (`elementor/core/dynamic-tags/manager.php:141-142`):
 *   sprintf('[%1$s id="%2$s" name="%3$s" settings="%4$s"]',
 *     'elementor-tag', $tag->get_id(), $tag->get_name(),
 *     urlencode( wp_json_encode( $settings, JSON_FORCE_OBJECT ) ));
 *
 * The two byte-exact details replicated here (the hardest part — verified against live `wp eval`):
 *  1. `wp_json_encode($s, JSON_FORCE_OBJECT)` — PHP `json_encode` DEFAULT flags + `JSON_FORCE_OBJECT`:
 *     - compact (no inter-token spaces) — JS `JSON.stringify(x)` already matches;
 *     - `/` is escaped to `\/` (PHP default; JS does NOT) — we post-escape it;
 *     - non-ASCII is escaped to lowercase `\uXXXX` per UTF-16 code unit, so e.g. `é`→`é` and an
 *       astral char emits its surrogate pair (`😀`) — JS leaves it literal; we post-escape it;
 *     - `JSON_FORCE_OBJECT` recursively renders arrays as objects (`[]`→`{}`, `[1,2]`→`{"0":1,"1":2}`),
 *       so we pre-transform every array to an object before `JSON.stringify`.
 *     Key order is preserved as inserted (both runtimes preserve string-key insertion order).
 *  2. `urlencode(...)` — PHP RFC1738-ish: keeps only `A-Za-z0-9` + `-` `_` `.`, encodes space as `+`, and
 *     percent-encodes EVERYTHING else with UPPERCASE hex. This differs from `encodeURIComponent` (which
 *     leaves `- _ . ! ~ * ' ( )` unescaped); we implement {@link phpUrlEncode} to match `urlencode` exactly.
 *
 * GOTCHA (SUPPLEMENT.md §A.6, the #1 footgun): empty settings encode to `settings="%7B%7D"` (urlencoded
 * `{}`), NEVER an empty string and NEVER `[]`. `JSON_FORCE_OBJECT` + the array→object transform guarantee
 * this for both `{}` and a stray `[]`.
 */

/** Core `Manager::TAG_LABEL` (`elementor/core/dynamic-tags/manager.php:16`). */
export const TAG_LABEL = 'elementor-tag';

/** Length of the random tag id Elementor's `get_id()` mints (7-char alphanumeric, SUPPLEMENT.md §A.6). */
const TAG_ID_LENGTH = 7;

/** The alphabet `generateTagId` draws from (lowercase alphanumeric — mirrors Elementor's `get_id()`). */
const TAG_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/* ───────────────────────────── JSON_FORCE_OBJECT (array → object) ──────────────────────────── */

/**
 * Recursively transform a value the way PHP `JSON_FORCE_OBJECT` does: every array becomes an object
 * keyed by its stringified indices (`[]`→`{}`, `[a,b]`→`{"0":a,"1":b}`), and nested objects/arrays are
 * transformed in place. Scalars (string/number/boolean/null) pass through unchanged. This runs BEFORE
 * `JSON.stringify` so the serialized shape matches `wp_json_encode($s, JSON_FORCE_OBJECT)` byte-for-byte
 * (verified against live `wp eval`). Object key insertion order is preserved (both runtimes preserve it).
 */
function forceObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < value.length; i += 1) {
      obj[String(i)] = forceObject(value[i]);
    }
    return obj;
  }
  if (value !== null && typeof value === 'object') {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      obj[k] = forceObject(v);
    }
    return obj;
  }
  return value;
}

/* ───────────────────────────── wp_json_encode (default flags) ─────────────────────────────── */

/**
 * Serialize `settings` exactly as `wp_json_encode($settings, JSON_FORCE_OBJECT)` (PHP default flags +
 * `JSON_FORCE_OBJECT`). Steps:
 *  1. {@link forceObject} so arrays render as objects (incl. empty `[]`→`{}`);
 *  2. `JSON.stringify` (compact, default — matches PHP's no-space output and short control escapes
 *     `\t`/`\n`/`\r`/`\"`/`\\` which PHP also emits);
 *  3. escape `/` → `\/` (PHP default escapes slashes; JS does not);
 *  4. escape every non-ASCII char (UTF-16 code unit > 0x7F) to lowercase `\uXXXX` (PHP default escapes
 *     unicode; JS leaves it literal). Iterating UTF-16 code units makes an astral char emit its surrogate
 *     pair (`😀`), matching PHP exactly.
 *
 * `<`, `>`, `&`, `'` are left literal (PHP default does NOT set `JSON_HEX_*`), matching JS `JSON.stringify`.
 */
export function wpJsonEncode(settings: Record<string, unknown>): string {
  const json = JSON.stringify(forceObject(settings));
  // `JSON.stringify` of a plain object never returns undefined; guard defensively for the type system.
  const compact = json ?? '{}';

  let out = '';
  for (let i = 0; i < compact.length; i += 1) {
    const ch = compact[i] as string;
    const code = compact.charCodeAt(i);
    if (ch === '/') {
      out += '\\/'; // PHP default escapes forward slashes.
    } else if (code > 0x7f) {
      out += '\\u' + code.toString(16).padStart(4, '0'); // lowercase \uXXXX per UTF-16 code unit.
    } else {
      out += ch;
    }
  }
  return out;
}

/* ───────────────────────────── php urlencode ──────────────────────────────────────────────── */

/** ASCII chars PHP `urlencode` leaves UNescaped (RFC1738-ish): `A-Za-z0-9` + `-` `_` `.` */
function isUrlencodeSafe(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x2d || // -
    code === 0x5f || // _
    code === 0x2e // .
  );
}

/**
 * Reproduce PHP `urlencode()` byte-for-byte. PHP `urlencode` keeps only `A-Za-z0-9-_.`, encodes space as
 * `+`, and percent-encodes every other byte (of the UTF-8 representation) with UPPERCASE hex. This is
 * NOT `encodeURIComponent` (which leaves `! ~ * ' ( )` literal and a space as `%20`). We encode the
 * UTF-8 bytes via {@link TextEncoder} so any multi-byte sequence (already escaped to `\uXXXX` by
 * {@link wpJsonEncode}, but defended here anyway) is percent-encoded per byte like PHP.
 */
export function phpUrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let out = '';
  for (const byte of bytes) {
    if (byte === 0x20) {
      out += '+'; // PHP urlencode: space → '+'
    } else if (isUrlencodeSafe(byte)) {
      out += String.fromCharCode(byte);
    } else {
      out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

/* ───────────────────────────── tag id ─────────────────────────────────────────────────────── */

/**
 * Mint a random 7-char lowercase-alphanumeric tag id (mirrors Elementor's `get_id()`, SUPPLEMENT.md
 * §A.6). The randomness makes live output non-deterministic by design; tests/fixtures pass an explicit
 * `id` to {@link encodeDynamicTag} for byte-stable assertions.
 */
export function generateTagId(): string {
  let id = '';
  for (let i = 0; i < TAG_ID_LENGTH; i += 1) {
    id += TAG_ID_ALPHABET[Math.floor(Math.random() * TAG_ID_ALPHABET.length)];
  }
  return id;
}

/* ───────────────────────────── encodeDynamicTag (the public API) ──────────────────────────── */

/**
 * Encode a dynamic-tag binding into the Elementor shortcode string, byte-identical to core
 * `Manager::tag_to_text()` (SUPPLEMENT.md §A.6):
 *
 *   `[elementor-tag id="<id>" name="<tagName>" settings="<urlencode(wp_json_encode(settings,FORCE_OBJECT))>"]`
 *
 * Empty `settings` → `settings="%7B%7D"` (the urlencoded `{}` — NEVER an empty string, the #1 gotcha).
 * `id` defaults to a fresh {@link generateTagId} (random 7-char); pass a fixed `id` for deterministic
 * fixtures/tests. This is a PREVIEW encoder — the authoritative write/encode is PHP (WP-R05); parity is
 * guaranteed by the cross-runtime fixture.
 */
export function encodeDynamicTag(
  tagName: string,
  settings: Record<string, unknown> = {},
  id: string = generateTagId(),
): string {
  const encodedSettings = phpUrlEncode(wpJsonEncode(settings));
  return `[${TAG_LABEL} id="${id}" name="${tagName}" settings="${encodedSettings}"]`;
}
