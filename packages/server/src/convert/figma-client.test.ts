/**
 * Contract 18 §4 — Composio Figma extraction client unit tests (mocked transport; ZERO network).
 *
 * Covers the §4 invariants this client owns: the fetch ALLOWLIST (the 13 write slugs are
 * HARD-DENIED with a loud refusal, an unknown slug is denied WITHOUT a list update — allowlist,
 * not denylist; the deny runs BEFORE any env/network access); the execute call shape
 * (`POST {base}/api/v3/tools/execute/{SLUG}`, `x-api-key`, `user_id` + optional
 * `connected_account_id`); env resolution with the DOCUMENTED defaults (`llctriox`); figma URL
 * parsing; and the §7 fetch-to-file + manifest RESUME convention (a complete manifest
 * short-circuits with zero upstream calls — the R1 mid-run-death field proof).
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildComposioFigmaPort,
  DEFAULT_COMPOSIO_BASE_URL,
  DEFAULT_COMPOSIO_FIGMA_USER,
  executeFigmaTool,
  fetchFrameToWorkDir,
  FIGMA_ARTIFACTS,
  FIGMA_FETCH_TOOL_ALLOWLIST,
  FIGMA_WRITE_TOOL_SLUGS,
  FigmaClientError,
  findFrameDocument,
  loadExtraction,
  normalizeFigmaNodeId,
  parseFigmaUrl,
  resolveFigmaEnv,
  type FetchLike,
  type FigmaClientEnv,
  type FigmaPort,
} from './figma-client.js';

/* ─────────────────────────── fixtures ────────────────────────────────────────────────────────── */

const ENV_OK: FigmaClientEnv = {
  apiKey: 'test-key',
  userId: 'llctriox',
  connectedAccountId: undefined,
  baseUrl: 'https://composio.test',
};

/** A recording fetch stub returning the queued responses in order. */
function fetchStub(responses: Array<{ status?: number; json?: unknown; text?: string }>): {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, ...(init !== undefined ? { init } : {}) });
    const spec = responses[Math.min(i++, responses.length - 1)] ?? {};
    const status = spec.status ?? 200;
    const body = spec.text ?? JSON.stringify(spec.json ?? { successful: true, data: {} });
    return Promise.resolve(
      new Response(body, { status, headers: { 'content-type': 'application/json' } }),
    );
  };
  return { fetchImpl, calls };
}

function clientError(fn: () => Promise<unknown>): Promise<FigmaClientError> {
  return fn().then(
    () => {
      throw new Error('expected a FigmaClientError throw');
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(FigmaClientError);
      return error as FigmaClientError;
    },
  );
}

/* ─────────────────────────── allowlist (§4 — allowlist, not denylist) ────────────────────────── */

describe('executeFigmaTool — the §4 hard-deny allowlist', () => {
  it('every write slug is HARD-DENIED with a loud, specific refusal', async () => {
    // The §4 "13 write slugs": the toolkit exposes ELEVEN write slug names covering THIRTEEN write
    // operations (FIGMA_CREATE_MODIFY_DELETE_VARIABLES is one slug carrying create+modify+delete).
    // All five write families are present: comments, reactions, webhooks, dev-resources, variables.
    expect(FIGMA_WRITE_TOOL_SLUGS).toHaveLength(11);
    for (const family of ['COMMENT', 'REACTION', 'WEBHOOK', 'DEV_RESOURCE', 'VARIABLES']) {
      expect(
        FIGMA_WRITE_TOOL_SLUGS.some((slug) => slug.includes(family)),
        family,
      ).toBe(true);
    }
    for (const slug of FIGMA_WRITE_TOOL_SLUGS) {
      const err = await clientError(() => executeFigmaTool(slug, {}));
      expect(err.code, slug).toBe('denied');
      expect(err.message, slug).toContain('HARD-DENIED');
      expect(err.message, slug).toContain(slug);
    }
  });

  it('an unaudited READ slug is denied too — allowlist, never a denylist update', async () => {
    const err = await clientError(() => executeFigmaTool('FIGMA_GET_TEAM_STYLES', {}));
    expect(err.code).toBe('denied');
    expect(err.message).toContain('allowlist');
  });

  it('the deny runs BEFORE env/network access (no api key, no fetch needed)', async () => {
    const { fetchImpl, calls } = fetchStub([]);
    const env: FigmaClientEnv = { ...ENV_OK, apiKey: undefined };
    const err = await clientError(() =>
      executeFigmaTool('FIGMA_CREATE_A_WEBHOOK', {}, { env, fetchImpl }),
    );
    expect(err.code).toBe('denied'); // NOT 'config' — the slug check wins
    expect(calls).toHaveLength(0);
  });

  it('the allowlist is exactly the three §4 fetch slugs', () => {
    expect([...FIGMA_FETCH_TOOL_ALLOWLIST]).toEqual([
      'FIGMA_GET_FILE_JSON',
      'FIGMA_RENDER_IMAGES_OF_FILE_NODES',
      'FIGMA_GET_IMAGE_FILLS',
    ]);
  });
});

/* ─────────────────────────── env resolution (documented defaults) ────────────────────────────── */

describe('resolveFigmaEnv — documented defaults, never hardcoded credentials', () => {
  it('defaults: user llctriox (the .mcp.json figma-composio user_id), Composio backend base', () => {
    const env = resolveFigmaEnv({});
    expect(env.userId).toBe(DEFAULT_COMPOSIO_FIGMA_USER);
    expect(env.userId).toBe('llctriox');
    expect(env.baseUrl).toBe(DEFAULT_COMPOSIO_BASE_URL);
    expect(env.apiKey).toBeUndefined();
    expect(env.connectedAccountId).toBeUndefined();
  });

  it('env overrides are honored and whitespace-trimmed', () => {
    const env = resolveFigmaEnv({
      COMPOSIO_API_KEY: ' k1 ',
      COMPOSIO_FIGMA_USER: 'other',
      COMPOSIO_FIGMA_ACCOUNT: 'ca_123',
      COMPOSIO_BASE_URL: 'https://composio.example',
    });
    expect(env.apiKey).toBe('k1');
    expect(env.userId).toBe('other');
    expect(env.connectedAccountId).toBe('ca_123');
    expect(env.baseUrl).toBe('https://composio.example');
  });

  it('an empty-string env var falls back to the default (not an empty credential)', () => {
    const env = resolveFigmaEnv({ COMPOSIO_API_KEY: '  ', COMPOSIO_FIGMA_USER: '' });
    expect(env.apiKey).toBeUndefined();
    expect(env.userId).toBe('llctriox');
  });
});

/* ─────────────────────────── the execute call ────────────────────────────────────────────────── */

describe('executeFigmaTool — the Composio execute call', () => {
  it('a missing COMPOSIO_API_KEY is a typed config error (environment, not upstream)', async () => {
    const { fetchImpl, calls } = fetchStub([]);
    const env: FigmaClientEnv = { ...ENV_OK, apiKey: undefined };
    const err = await clientError(() =>
      executeFigmaTool('FIGMA_GET_FILE_JSON', {}, { env, fetchImpl }),
    );
    expect(err.code).toBe('config');
    expect(err.message).toContain('COMPOSIO_API_KEY');
    expect(calls).toHaveLength(0);
  });

  it('POSTs {base}/api/v3/tools/execute/{SLUG} with x-api-key + user_id and returns data', async () => {
    const { fetchImpl, calls } = fetchStub([
      { json: { successful: true, data: { nodes: { a: 1 } } } },
    ]);
    const data = await executeFigmaTool(
      'FIGMA_GET_FILE_JSON',
      { file_key: 'KEY', ids: '1:2', response_detail: 'full' },
      { env: ENV_OK, fetchImpl },
    );
    expect(data).toEqual({ nodes: { a: 1 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://composio.test/api/v3/tools/execute/FIGMA_GET_FILE_JSON');
    const init = calls[0]?.init;
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('test-key');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['user_id']).toBe('llctriox');
    expect(body['arguments']).toEqual({ file_key: 'KEY', ids: '1:2', response_detail: 'full' });
    expect('connected_account_id' in body).toBe(false);
  });

  it('carries connected_account_id when COMPOSIO_FIGMA_ACCOUNT is set', async () => {
    const { fetchImpl, calls } = fetchStub([{ json: { successful: true, data: {} } }]);
    await executeFigmaTool(
      'FIGMA_GET_IMAGE_FILLS',
      { file_key: 'KEY' },
      { env: { ...ENV_OK, connectedAccountId: 'ca_9' }, fetchImpl },
    );
    const body = JSON.parse(calls[0]?.init?.body as string) as Record<string, unknown>;
    expect(body['connected_account_id']).toBe('ca_9');
  });

  it('a non-2xx response is an http error carrying the status', async () => {
    const { fetchImpl } = fetchStub([{ status: 429, text: 'rate limited' }]);
    const err = await clientError(() =>
      executeFigmaTool('FIGMA_GET_FILE_JSON', {}, { env: ENV_OK, fetchImpl }),
    );
    expect(err.code).toBe('http');
    expect(err.message).toContain('429');
  });

  it('successful:false is a tool_failed error carrying the upstream message', async () => {
    const { fetchImpl } = fetchStub([
      { json: { successful: false, error: 'Invalid node id', data: null } },
    ]);
    const err = await clientError(() =>
      executeFigmaTool('FIGMA_GET_FILE_JSON', {}, { env: ENV_OK, fetchImpl }),
    );
    expect(err.code).toBe('tool_failed');
    expect(err.message).toContain('Invalid node id');
  });
});

/* ─────────────────────────── figma URL parsing ───────────────────────────────────────────────── */

describe('parseFigmaUrl / normalizeFigmaNodeId', () => {
  it('parses a design URL and normalizes the hyphen node-id to the API colon form', () => {
    const parsed = parseFigmaUrl(
      'https://www.figma.com/design/ogxmGWnTEJK3TEPnMWp2by/WPOS?node-id=400-7508&t=xyz',
    );
    expect(parsed).toEqual({ file_key: 'ogxmGWnTEJK3TEPnMWp2by', node_id: '400:7508' });
  });

  it('accepts the legacy /file/ path and a missing node-id', () => {
    const parsed = parseFigmaUrl('https://figma.com/file/abcDEF123/Some-Name');
    expect(parsed).toEqual({ file_key: 'abcDEF123' });
  });

  it('rejects a non-URL and a URL without a file key', () => {
    expect(() => parseFigmaUrl('not a url')).toThrow(FigmaClientError);
    expect(() => parseFigmaUrl('https://figma.com/community/whatever')).toThrow(FigmaClientError);
  });

  it('normalizeFigmaNodeId maps 400-7508 → 400:7508 (idempotent on colon form)', () => {
    expect(normalizeFigmaNodeId('400-7508')).toBe('400:7508');
    expect(normalizeFigmaNodeId('400:7508')).toBe('400:7508');
    expect(normalizeFigmaNodeId(' I400-7509;29-15170 ')).toBe('I400:7509;29:15170');
  });
});

/* ─────────────────────────── buildComposioFigmaPort (shape plucks + download) ────────────────── */

describe('buildComposioFigmaPort', () => {
  it('renderNodes plucks the images map and defaults format:png', async () => {
    const { fetchImpl, calls } = fetchStub([
      { json: { successful: true, data: { images: { '1:2': 'https://s3/img.png' } } } },
    ]);
    const port = buildComposioFigmaPort({ env: ENV_OK, fetchImpl });
    const images = await port.renderNodes({ file_key: 'KEY', ids: '1:2' });
    expect(images).toEqual({ '1:2': 'https://s3/img.png' });
    const body = JSON.parse(calls[0]?.init?.body as string) as {
      arguments: Record<string, unknown>;
    };
    expect(body.arguments['format']).toBe('png');
  });

  it('getFileJson maps response_detail onto the HONORED simplify flag (live Composio drift)', async () => {
    // Live-verified 2026-06-11: the execute API ignores `response_detail` — a 'full' request came
    // back simplified and figma-parse rightly refused it. `simplify:false` is what the backend
    // honors; both params ride the call (the documented one for forward-compat).
    const { fetchImpl, calls } = fetchStub([
      { json: { successful: true, data: {} } },
      { json: { successful: true, data: {} } },
    ]);
    const port = buildComposioFigmaPort({ env: ENV_OK, fetchImpl });
    await port.getFileJson({ file_key: 'KEY', ids: '400:7508', response_detail: 'full' });
    await port.getFileJson({ file_key: 'KEY', ids: '400:7508', response_detail: 'minimal' });
    const args = (i: number): Record<string, unknown> =>
      (JSON.parse(calls[i]?.init?.body as string) as { arguments: Record<string, unknown> })
        .arguments;
    expect(args(0)['simplify']).toBe(false);
    expect(args(0)['response_detail']).toBe('full');
    expect(args(1)['simplify']).toBe(true);
  });

  it('getImageFills plucks the REST {meta:{images}} shape (and tolerates flattened images)', async () => {
    const { fetchImpl } = fetchStub([
      { json: { successful: true, data: { meta: { images: { ref1: 'https://s3/fill.png' } } } } },
    ]);
    const port = buildComposioFigmaPort({ env: ENV_OK, fetchImpl });
    expect(await port.getImageFills('KEY')).toEqual({ ref1: 'https://s3/fill.png' });
  });

  it('download surfaces an EXPIRY-aware http error on a non-200 (temp URLs expire 14/30d)', async () => {
    const { fetchImpl } = fetchStub([{ status: 403, text: 'expired' }]);
    const port = buildComposioFigmaPort({ env: ENV_OK, fetchImpl });
    const err = await clientError(() => port.download('https://s3/dead.png'));
    expect(err.code).toBe('http');
    expect(err.message).toContain('expire');
  });
});

/* ─────────────────────────── fetch-to-file + manifest resume (§7) ────────────────────────────── */

/** An in-memory FigmaPort recording every upstream call (the §7 zero-re-fetch assertions). */
function fakePort(): { port: FigmaPort; calls: string[] } {
  const calls: string[] = [];
  const rawDoc = {
    nodes: {
      '400:7508': {
        document: {
          id: '400:7508',
          type: 'FRAME',
          name: 'Homepage',
          absoluteBoundingBox: { width: 1440, height: 6225.4 },
        },
      },
    },
  };
  const port: FigmaPort = {
    getFileJson(req): Promise<unknown> {
      calls.push(`json:${req.response_detail}`);
      return Promise.resolve(req.response_detail === 'full' ? rawDoc : { simplified: true });
    },
    renderNodes(req): Promise<Record<string, string | null>> {
      calls.push('render');
      return Promise.resolve({ [req.ids]: 'https://figma-renders/frame.png' });
    },
    getImageFills(): Promise<Record<string, string>> {
      calls.push('fills');
      return Promise.resolve({ imgref1: 'https://s3/fill-1.png' });
    },
    download(url): Promise<Uint8Array> {
      calls.push(`download:${url}`);
      return Promise.resolve(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    },
  };
  return { port, calls };
}

describe('fetchFrameToWorkDir — fetch-to-file + the §7 manifest resume convention', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), 'emcp-figma-test-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('a fresh fetch persists every artifact + the manifest LAST, in the §7 shape', async () => {
    const { port, calls } = fakePort();
    const extraction = await fetchFrameToWorkDir(port, {
      file_key: 'KEY',
      node_id: '400-7508', // hyphen form accepted
      work_dir: workDir,
    });

    expect(extraction.resumed).toBe(false);
    // BOTH simplify modes were fetched (§4: simplified strips text typography).
    expect(calls).toEqual([
      'json:full',
      'json:minimal',
      'render',
      'download:https://figma-renders/frame.png',
      'fills',
    ]);
    for (const file of Object.values(FIGMA_ARTIFACTS)) {
      expect(existsSync(path.join(workDir, file)), file).toBe(true);
    }

    // The §7 NORMATIVE manifest convention: {file_key, node_id, frame_name, frame_size, asset_map}.
    const manifest = extraction.manifest;
    expect(manifest.file_key).toBe('KEY');
    expect(manifest.node_id).toBe('400:7508');
    expect(manifest.frame_name).toBe('Homepage');
    expect(manifest.frame_size).toEqual({ width: 1440, height: 6225 });
    expect(manifest.asset_map['imgref1']).toBe('https://s3/fill-1.png');
    expect(manifest.asset_map['render:400:7508']).toBe('https://figma-renders/frame.png');
    expect(manifest.fetched_at).toBeTruthy();

    const onDisk = JSON.parse(
      await readFile(path.join(workDir, FIGMA_ARTIFACTS.manifest), 'utf8'),
    ) as typeof manifest;
    expect(onDisk).toEqual(manifest);
  });

  it('RESUME: a complete manifest short-circuits with ZERO upstream calls (never re-fetch)', async () => {
    const first = fakePort();
    await fetchFrameToWorkDir(first.port, {
      file_key: 'KEY',
      node_id: '400:7508',
      work_dir: workDir,
    });

    const second = fakePort();
    const resumed = await fetchFrameToWorkDir(second.port, {
      file_key: 'KEY',
      node_id: '400:7508',
      work_dir: workDir,
    });
    expect(resumed.resumed).toBe(true);
    expect(second.calls).toEqual([]);
    expect(resumed.manifest.frame_name).toBe('Homepage');
  });

  it('a manifest for a DIFFERENT frame is NOT resumable — the dir is re-fetched', async () => {
    const first = fakePort();
    await fetchFrameToWorkDir(first.port, {
      file_key: 'KEY',
      node_id: '400:7508',
      work_dir: workDir,
    });
    const second = fakePort();
    const other = await fetchFrameToWorkDir(second.port, {
      file_key: 'OTHERKEY',
      node_id: '400:7508',
      work_dir: workDir,
    });
    expect(other.resumed).toBe(false);
    expect(second.calls.length).toBeGreaterThan(0);
  });

  it('a missing/null render URL is a bad_response (invalid id / invisible node)', async () => {
    const { port } = fakePort();
    const broken: FigmaPort = {
      ...port,
      renderNodes: () => Promise.resolve({ '400:7508': null }),
    };
    const err = await clientError(() =>
      fetchFrameToWorkDir(broken, { file_key: 'KEY', node_id: '400:7508', work_dir: workDir }),
    );
    expect(err.code).toBe('bad_response');
  });

  it('loadExtraction reads the payloads back from disk (the resume side of fetch-to-file)', async () => {
    const { port } = fakePort();
    await fetchFrameToWorkDir(port, { file_key: 'KEY', node_id: '400:7508', work_dir: workDir });
    const loaded = await loadExtraction(workDir);
    expect(loaded.manifest.node_id).toBe('400:7508');
    expect(loaded.simplified).toEqual({ simplified: true });
    expect(loaded.image_fills).toEqual({ imgref1: 'https://s3/fill-1.png' });
    expect(Array.from(loaded.render_png)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect((loaded.raw as { nodes: Record<string, unknown> }).nodes['400:7508']).toBeDefined();
  });

  it('F3 honesty: the manifest carries the temp URLs (sideload-time only), artifacts stay relative', async () => {
    const { port } = fakePort();
    const { manifest } = await fetchFrameToWorkDir(port, {
      file_key: 'KEY',
      node_id: '400:7508',
      work_dir: workDir,
    });
    // Artifact paths are RELATIVE filenames (the work dir can move hosts between agent runs).
    expect(manifest.artifacts).toEqual({
      raw: 'raw.json',
      simplified: 'simplified.json',
      render: 'render.png',
      image_fills: 'image-fills.json',
    });
  });
});

/* ─────────────────────────── frame-document mining ───────────────────────────────────────────── */

describe('findFrameDocument', () => {
  it('mines name + rounded size from the raw /nodes response', () => {
    const raw = {
      nodes: {
        '1:2': {
          document: {
            id: '1:2',
            type: 'FRAME',
            name: 'Hero',
            absoluteBoundingBox: { width: 1439.6, height: 790.2 },
          },
        },
      },
    };
    expect(findFrameDocument(raw, '1:2')).toEqual({
      name: 'Hero',
      size: { width: 1440, height: 790 },
    });
  });

  it('returns undefined off-shape (the manifest then degrades to node-id + 0×0)', () => {
    expect(findFrameDocument({ unexpected: true }, '1:2')).toBeUndefined();
    expect(findFrameDocument(null, '1:2')).toBeUndefined();
  });
});

/* ─────────────────────────── the committed cluster-1 fixture drives the miner ────────────────── */

describe('the committed Figma fixture (fixtures/figma/wpos-v2-hero.json)', () => {
  it('findFrameDocument mines the real WPOS hero frame from the byte-faithful API shape', async () => {
    const fixturePath = new URL('../../fixtures/figma/wpos-v2-hero.json', import.meta.url);
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as unknown;
    const frame = findFrameDocument(fixture, '400:7510');
    expect(frame).toBeDefined();
    expect(frame?.size.width).toBe(1440);
    expect(frame?.size.height).toBe(790);
  });
});
