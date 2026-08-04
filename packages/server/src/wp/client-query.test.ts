/**
 * WP-F02 — query-string serialization tests (M-d, contract 18 §7).
 *
 * The root cause of "design_classes_list fields=['id','label'] returns only {label}": the client
 * appended array query params as a BARE repeated key (`fields=id&fields=label`), which WP/PHP query
 * parsing collapses to the LAST value — the projection then dropped every requested field but one.
 * Arrays must serialize in PHP `key[]` form so `$request->get_param('fields')` receives the full
 * array. Asserted here against a stubbed fetch (no live WordPress).
 */

import { describe, expect, it, vi } from 'vitest';

import { WpClient } from './client.js';

function makeClient(): { client: WpClient; fetchImpl: ReturnType<typeof vi.fn> } {
  const fetchImpl = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ success: true, data: { items: [], order: [], next_cursor: null, total: 0 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  const client = new WpClient({
    site: { url: 'http://example.test', basicToken: 'dGVzdDp0ZXN0' },
    fetchImpl,
  });
  return { client, fetchImpl };
}

describe('WpClient query serialization (M-d, contract 18 §7)', () => {
  it('serializes array params in PHP `key[]` form so no entry collapses away', async () => {
    const { client, fetchImpl } = makeClient();
    await client.request('listGlobalClasses', {
      query: { limit: 2, fields: ['id', 'label'] },
    });
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    // `fields[]=id&fields[]=label` (URL-encoded brackets) — BOTH entries survive PHP parsing.
    expect(url).toContain('fields%5B%5D=id');
    expect(url).toContain('fields%5B%5D=label');
    // The bare repeated-key form (the M-d bug) must NOT appear.
    expect(url).not.toMatch(/[?&]fields=/);
  });

  it('scalar params keep their bare key form', async () => {
    const { client, fetchImpl } = makeClient();
    await client.request('listGlobalClasses', { query: { limit: 5, cursor: 'abc' } });
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain('limit=5');
    expect(url).toContain('cursor=abc');
    expect(url).not.toContain('limit%5B%5D');
  });
});
