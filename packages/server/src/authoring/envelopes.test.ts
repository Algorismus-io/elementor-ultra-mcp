/**
 * Envelope guards — focused unit tests.
 *
 * Regression lock for the `image-src` id-XOR-url check: Elementor's own convention sets the UNUSED side
 * to `null` (e.g. `{id, url:null}` for a library image), and the authoritative PHP validator accepts it —
 * so the pre-filter must treat `null` as ABSENT, not "present". (A stricter check false-rejected every
 * sideloaded library image, e.g. the whole Amundsen rebuild.)
 */

import { describe, expect, it } from 'vitest';

import { isValidImageSrc } from './envelopes.js';

const imageSrc = (inner: Record<string, unknown>) => ({ $$type: 'image-src', value: inner });
const idEnv = { $$type: 'image-attachment-id', value: 777 };
const urlEnv = { $$type: 'url', value: 'https://example.com/a.jpg' };

describe('isValidImageSrc — id-XOR-url with null-as-absent', () => {
  it('accepts {id, url:null} (the WP library-image convention)', () => {
    expect(isValidImageSrc(imageSrc({ id: idEnv, url: null }))).toBe(true);
  });

  it('accepts {url, id:null} (the external-image convention)', () => {
    expect(isValidImageSrc(imageSrc({ id: null, url: urlEnv }))).toBe(true);
  });

  it('accepts id-only and url-only', () => {
    expect(isValidImageSrc(imageSrc({ id: idEnv }))).toBe(true);
    expect(isValidImageSrc(imageSrc({ url: urlEnv }))).toBe(true);
  });

  it('rejects BOTH id and url set (true XOR violation)', () => {
    expect(isValidImageSrc(imageSrc({ id: idEnv, url: urlEnv }))).toBe(false);
  });

  it('rejects neither set (both null)', () => {
    expect(isValidImageSrc(imageSrc({ id: null, url: null }))).toBe(false);
  });

  it('rejects a non image-src typed value', () => {
    expect(isValidImageSrc({ $$type: 'color', value: '#fff' })).toBe(false);
  });
});
