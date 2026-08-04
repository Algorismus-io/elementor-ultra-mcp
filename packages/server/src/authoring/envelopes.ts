/**
 * WP-F03 — Typed-envelope constructors + typeguards for the V4 atomic authoring contract.
 *
 * Realizes the `$$type` envelope rules of `11-authoring-contract.md §3`:
 *   - Every atomic prop value is `{$$type, value, disabled?}` where `$$type` MUST equal the prop
 *     type's `get_key()` (`prop-types/concerns/has-generate.php:11-22`).
 *   - The `classes` envelope's `value` is a BARE string array (NO inner wrapping,
 *     `classes-prop-type.php:22`).
 *   - UNION is NOT itself wrapped — the chosen member's own envelope is emitted
 *     (`union-prop-type.php:74-96`); these helpers never double-wrap.
 *   - `image-src` is strict id-XOR-url (NEVER both, NEVER neither, `image-src-prop-type.php:36-44`).
 *   - `html-v3` inner markup is filtered to the inline-only allowlist
 *     `[b,i,em,u,a,del,span,strong,sup,sub,s]` (`html-v3-prop-type.php:82,91`).
 *
 * AUTHORITY: PHP `dry_run` (WP-P03) is the single source of truth for validity. These guards are a
 * cheap structural subset (`15-engineering-standards.md §2.5`); the write-path verdict is in
 * `./prefilter.ts`.
 */

import type { TypedValue, Classes, ImageSrc, HtmlV3, Size, Dimensions } from './contract.js';

/* ───────────────────────────── core envelope guard / constructor ─────────────────────────── */

/** The class-name pattern (`11-authoring-contract.md §3.1`, R7): `/^[A-Za-z][A-Za-z0-9_-]*$/`. */
export const CLASS_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * The `html-v3` inline-only allowlist (`html-v3-prop-type.php:82,91`,
 * `11-authoring-contract.md §3.3`). Every other tag is SILENTLY STRIPPED by `wp_kses` at save.
 */
export const HTML_V3_INLINE_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  'b',
  'i',
  'em',
  'u',
  'a',
  'del',
  'span',
  'strong',
  'sup',
  'sub',
  's',
]);

/** True when `value` is a non-null plain object (record). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural typeguard for ANY typed envelope: a record with a string `$$type` and a `value` key,
 * plus an optional boolean `disabled`. Does NOT check that `$$type` is a registered key — that is
 * PHP's call (`11-authoring-contract.md §3`).
 */
export function isTypedValue(value: unknown): value is TypedValue {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value['$$type'] !== 'string') {
    return false;
  }
  if (!('value' in value)) {
    return false;
  }
  if ('disabled' in value && typeof value['disabled'] !== 'boolean') {
    return false;
  }
  return true;
}

/** True iff `value` is a typed envelope whose `$$type` equals `expected` (the `get_key()` match). */
export function isTypedValueOf<TType extends string>(
  value: unknown,
  expected: TType,
): value is TypedValue<TType> {
  return isTypedValue(value) && value.$$type === expected;
}

/**
 * Construct a typed envelope `{$$type, value, disabled?}`. The `$$type` you pass MUST be the prop
 * type's `get_key()`; this constructor never wraps a value that is already an envelope (UNION
 * single-wrap rule) — callers pass the inner member directly.
 */
export function typedValue<TType extends string, TVal>(
  $$type: TType,
  value: TVal,
  disabled?: boolean,
): TypedValue<TType, TVal> {
  return disabled === undefined ? { $$type, value } : { $$type, value, disabled };
}

/* ───────────────────────────── classes (BARE string array) ──────────────────────────────── */

/**
 * Construct a `classes` envelope (`11-authoring-contract.md §3`,
 * `classes-prop-type.php:22`). `value` is a BARE string array — NEVER wrapped per-item. Holds both
 * global-class ids (`g-*`) and local-style ids (`e-<elementId>-<7hex>`).
 */
export function classesValue(names: string[]): Classes {
  return { $$type: 'classes', value: [...names] };
}

/**
 * Typeguard for a well-formed `classes` envelope: `$$type:'classes'` with a BARE string array whose
 * members match {@link CLASS_NAME_PATTERN}. Rejects double-wrapped (envelope-per-item) shapes.
 */
export function isClassesValue(value: unknown): value is Classes {
  if (!isTypedValueOf(value, 'classes')) {
    return false;
  }
  const arr = (value as Classes).value;
  return (
    Array.isArray(arr) &&
    arr.every((name) => typeof name === 'string' && CLASS_NAME_PATTERN.test(name))
  );
}

/* ───────────────────────────── image-src (id XOR url) ────────────────────────────────────── */

/**
 * True iff `value` is a valid `image-src` envelope honoring id-XOR-url
 * (`image-src-prop-type.php:36-44`): exactly ONE of `id`/`url` present (NEVER both, NEVER neither).
 * A runtime violation maps to `IMAGE_SRC_XOR_VIOLATION` in the pre-filter.
 */
export function isValidImageSrc(value: unknown): value is ImageSrc {
  if (!isTypedValueOf(value, 'image-src')) {
    return false;
  }
  const inner = (value as ImageSrc).value;
  if (!isRecord(inner)) {
    return false;
  }
  // Treat `null` as ABSENT (not just `undefined`): Elementor's own `image-src` convention sets the
  // unused side to `null` (e.g. `{id, url:null}` for a library image) and the authoritative PHP validator
  // accepts it. Counting `null` as "present" made the pre-filter STRICTER than reality, false-rejecting
  // the standard library-image shape.
  const hasId = 'id' in inner && inner['id'] !== undefined && inner['id'] !== null;
  const hasUrl = 'url' in inner && inner['url'] !== undefined && inner['url'] !== null;
  return hasId !== hasUrl; // logical XOR
}

/** Construct an ID-only `image-src` (preferred for WP-library media, sideload first). */
export function imageSrcById(idEnvelope: TypedValue, altEnvelope?: TypedValue): ImageSrc {
  const inner: { id: TypedValue; alt?: TypedValue } = { id: idEnvelope };
  if (altEnvelope !== undefined) {
    inner.alt = altEnvelope;
  }
  return { $$type: 'image-src', value: inner };
}

/** Construct a URL-only `image-src` (true externals only). */
export function imageSrcByUrl(urlEnvelope: TypedValue, altEnvelope?: TypedValue): ImageSrc {
  const inner: { url: TypedValue; alt?: TypedValue } = { url: urlEnvelope };
  if (altEnvelope !== undefined) {
    inner.alt = altEnvelope;
  }
  return { $$type: 'image-src', value: inner };
}

/* ───────────────────────────── html-v3 (inline allowlist) ───────────────────────────────── */

/** A simple inline tag-name extractor (opening/closing tags) for the allowlist diff. */
const TAG_NAME_RE = /<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)/g;

/**
 * Return the set of tag names present in an html-v3 `content` string that are NOT in the inline-only
 * allowlist — the tags `wp_kses` would silently strip (`11-authoring-contract.md §3.3`). Producers
 * surface this as the soft `HTML_V3_STRIPPED` report (`CoverageReport.stripped_text`).
 */
export function strippedHtmlV3Tags(content: string): string[] {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  TAG_NAME_RE.lastIndex = 0;
  while ((match = TAG_NAME_RE.exec(content)) !== null) {
    const tag = match[1]?.toLowerCase();
    if (tag !== undefined && !HTML_V3_INLINE_ALLOWLIST.has(tag)) {
      found.add(tag);
    }
  }
  return [...found];
}

/** Typeguard for an `html-v3` envelope (`{content?:string-envelope|null, children?:[]}`). */
export function isHtmlV3(value: unknown): value is HtmlV3 {
  if (!isTypedValueOf(value, 'html-v3')) {
    return false;
  }
  const inner = (value as HtmlV3).value;
  if (!isRecord(inner)) {
    return false;
  }
  if ('content' in inner && inner['content'] !== null && inner['content'] !== undefined) {
    if (!isTypedValueOf(inner['content'], 'string')) {
      return false;
    }
  }
  if ('children' in inner && inner['children'] !== undefined && !Array.isArray(inner['children'])) {
    return false;
  }
  return true;
}

/**
 * Construct an `html-v3` envelope from raw inline markup. `content` is wrapped as a `string` envelope
 * (`{$$type:'string',value}`); `children` defaults to `[]`. The caller is responsible for promoting
 * block-level content to sibling nodes first (only inline tags survive `wp_kses`).
 */
export function htmlV3(content: string | null, children: unknown[] = []): HtmlV3 {
  return {
    $$type: 'html-v3',
    value: {
      content: content === null ? null : { $$type: 'string', value: content },
      children,
    },
  };
}

/* ───────────────────────────── size / dimensions convenience ─────────────────────────────── */

/** Construct a `size` envelope. `'auto'` ⇒ size null; `'custom'` ⇒ size is a string. */
export function sizeValue(size: number | string | null, unit: string): Size {
  return { $$type: 'size', value: { unit, size } };
}

/** Construct a `dimensions` envelope from per-logical-edge `size` envelopes (never physical edges). */
export function dimensionsValue(edges: {
  'block-start'?: Size;
  'inline-end'?: Size;
  'block-end'?: Size;
  'inline-start'?: Size;
}): Dimensions {
  return { $$type: 'dimensions', value: { ...edges } };
}
