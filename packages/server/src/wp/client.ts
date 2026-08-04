/**
 * WP-F02 — The single typed HTTP client for Seam B (the ONLY TS module that talks HTTP to the
 * companion plugin). `01-architecture.md §2.2`.
 *
 * Responsibilities (and ONLY these — no tool-shaped logic, `01-architecture.md §1.2`):
 *  - Inject `Authorization: Basic <token>` on EVERY call to both `wp/v2/*` and `elementor-ultra/v1/*`
 *    (`10-rest-api.md §0.2`). The client makes NO trust decisions — AuthN/Z is PHP's
 *    (`01-architecture.md §7`).
 *  - JSON encode/decode; unwrap the success envelope (`{success,data}` → `data`, `10-rest-api.md §0.5`).
 *  - Map the error envelope (`{code,message,data:{status,...}}`, §0.6) to a typed {@link WpClientError}
 *    carrying the frozen `McpErrorPayload` (taxonomy code, `12-error-taxonomy.md §2`).
 *  - Retry-with-backoff ONLY for the transient taxonomy codes (`RATE_LIMITED`, `UPSTREAM_ERROR`,
 *    `CSS_PRIME_FAILED`), NEVER for concurrency codes (`12-error-taxonomy.md §5.3`) — and ONLY for
 *    requests that are safe to re-send: GETs, inherently idempotent routes, and replay-protected
 *    write routes carrying an `op_id` ({@link isRetrySafeRequest}). A transport failure can land
 *    AFTER the server applied a write, so blindly re-sending a non-idempotent POST duplicates
 *    pages/attachments; those now fail fast to the caller instead.
 *  - A pagination cursor-follow helper that fetches the NEXT page only when explicitly asked — no
 *    unbounded auto-fetch path exists (`15-engineering-standards.md §2.9`).
 *
 * Uses the Node 20 global `fetch` (no axios). The client never invents `op_id`/`base_hash`
 * (`10-rest-api.md §0.8`); callers thread them.
 */

import {
  ERROR_CODE_META,
  ErrorCodes,
  makeErrorPayload,
  REST_BASE_PATH,
  ROUTES,
  buildRoutePath,
  type ErrorCode,
  type Paginated,
  type RouteName,
} from '@elementor-ultra/shared';

import { WpClientError, type RestFieldErrorLike, type SiteConfig } from './types.js';

/* ───────────────────────────── error-code mapping (envelope → taxonomy) ─────────────────── */

/**
 * Map a non-taxonomy envelope `code` slug to a taxonomy {@link ErrorCode}. Covers the `E_`-prefixed
 * REST codes (`10-rest-api.md §15`) and the WordPress/Elementor source slugs (`12-error-taxonomy.md
 * §4`). A taxonomy code that already matches is used as-is (see {@link mapEnvelopeCode}).
 */
const SLUG_TO_CODE: Readonly<Record<string, ErrorCode>> = Object.freeze({
  // WordPress / Elementor core slugs (12-error-taxonomy.md §4).
  rest_not_logged_in: ErrorCodes.AUTH_FAILED,
  rest_forbidden: ErrorCodes.CAPABILITY_MISSING,
  global_classes_limit_exceeded: ErrorCodes.BUDGET_EXCEEDED,
  invalid_order: ErrorCodes.INVALID_ORDER,
  DUPLICATED_LABEL: ErrorCodes.DUPLICATED_LABEL,
  // `E_`-prefixed REST codes (10-rest-api.md §15 / §0.7).
  E_BAD_REQUEST: ErrorCodes.VALIDATION_FAILED,
  E_MISSING_PARAM: ErrorCodes.VALIDATION_FAILED,
  E_FORBIDDEN_CAP: ErrorCodes.CAPABILITY_MISSING,
  E_NOT_FOUND: ErrorCodes.NOT_FOUND,
  E_BASE_HASH_MISMATCH: ErrorCodes.CONCURRENCY_STALE_HASH,
  E_AUTOSAVE_CONFLICT: ErrorCodes.AUTOSAVE_CONFLICT,
  E_POST_LOCKED: ErrorCodes.LOCK_HELD,
  E_ATOMIC_VALIDATION: ErrorCodes.ATOMIC_SETTINGS_INVALID,
  E_SETTINGS_INVALID: ErrorCodes.SETTINGS_INVALID,
  E_RENDER_FAILED: ErrorCodes.RENDER_FAILED,
  E_PROP_INVALID: ErrorCodes.ATOMIC_SETTINGS_INVALID,
  E_STYLE_INVALID: ErrorCodes.ATOMIC_STYLES_INVALID,
  E_UNKNOWN_TYPE: ErrorCodes.UNKNOWN_WIDGET_TYPE,
  E_ID_COLLISION: ErrorCodes.DUPLICATE_ELEMENT_ID,
  E_BUDGET_EXCEEDED: ErrorCodes.BUDGET_EXCEEDED,
  E_INVALID_ORDER: ErrorCodes.INVALID_ORDER,
  E_DUPLICATED_LABEL: ErrorCodes.DUPLICATED_LABEL,
  E_TYPE_MISMATCH: ErrorCodes.VALIDATION_FAILED,
  E_BATCH_FAILED: ErrorCodes.VALIDATION_FAILED,
  E_MEDIA_TYPE: ErrorCodes.VALIDATION_FAILED,
  E_LOOP_TEMPLATE_INVALID: ErrorCodes.VALIDATION_FAILED,
  E_DYNAMIC_INCOMPATIBLE: ErrorCodes.VALIDATION_FAILED,
  E_WOO_CONTEXT_INVALID: ErrorCodes.WOO_CONTEXT_INVALID,
  E_FEATURE_UNAVAILABLE: ErrorCodes.EXPERIMENT_INACTIVE,
  E_COMPENSATION_FAILED: ErrorCodes.INTERNAL_ERROR,
  E_INTERNAL: ErrorCodes.INTERNAL_ERROR,
});

const TAXONOMY_CODES: ReadonlySet<string> = new Set(Object.keys(ERROR_CODE_META));

/** Map an HTTP status to a taxonomy code when no usable `code` slug is present (`10-rest-api.md §0.7`). */
function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return ErrorCodes.AUTH_FAILED;
    case 403:
      return ErrorCodes.CAPABILITY_MISSING;
    case 404:
      return ErrorCodes.NOT_FOUND;
    case 409:
      return ErrorCodes.CONCURRENCY_STALE_HASH;
    case 422:
      return ErrorCodes.VALIDATION_FAILED;
    case 429:
      return ErrorCodes.RATE_LIMITED;
    case 501:
      return ErrorCodes.EXPERIMENT_INACTIVE;
    case 502:
    case 503:
    case 504:
      return ErrorCodes.UPSTREAM_ERROR;
    case 400:
      return ErrorCodes.VALIDATION_FAILED;
    default:
      return status >= 500 ? ErrorCodes.INTERNAL_ERROR : ErrorCodes.UPSTREAM_ERROR;
  }
}

/**
 * Resolve an envelope `code` + HTTP status to a taxonomy {@link ErrorCode}. Order: an exact taxonomy
 * code wins; then a known slug; then the HTTP-status fallback.
 */
export function mapEnvelopeCode(code: string | undefined, status: number): ErrorCode {
  if (code && TAXONOMY_CODES.has(code)) {
    return code as ErrorCode;
  }
  if (code && code in SLUG_TO_CODE) {
    return SLUG_TO_CODE[code] as ErrorCode;
  }
  return codeForStatus(status);
}

/* ───────────────────────────── retry policy (12-error-taxonomy.md §5.3) ──────────────────── */

/**
 * The ONLY codes the client auto-retries (`12-error-taxonomy.md §5.3`): transient codes. Concurrency
 * codes (`LOCK_HELD`, `AUTOSAVE_CONFLICT`, `CONCURRENCY_STALE_HASH`, `WATERMARK_STALE`) are NEVER
 * auto-retried — they require an agent decision (re-read / `force`).
 */
export const CLIENT_RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ErrorCodes.RATE_LIMITED,
  ErrorCodes.UPSTREAM_ERROR,
  ErrorCodes.CSS_PRIME_FAILED,
]);

/** True when the client may auto-retry this taxonomy code (transient only, never concurrency). */
export function isClientRetryable(code: ErrorCode): boolean {
  return CLIENT_RETRYABLE_CODES.has(code);
}

/**
 * Write routes whose PHP handlers are verified replay-protected by a server-side `op_id` guard:
 * the `Document_Writer` paths (`op_already_applied` before any write), the documents controller's
 * create replay guard (`Op_Log::find_by_op_id`), and the batch runner's `find_by_op_id`. Re-sending
 * one of these with the SAME `op_id` is safe — the server returns the original result instead of
 * applying the write twice — so auto-retry is allowed ONLY when the request body actually carries
 * an `op_id` ({@link isRetrySafeRequest}).
 */
const OP_ID_REPLAY_ROUTES: ReadonlySet<RouteName> = new Set<RouteName>([
  'createDocument',
  'saveDocument',
  'replaceTree',
  'elementOps',
  'updateDocumentSettings',
  'batchApply',
]);

/**
 * Non-GET routes that are side-effect-free or naturally idempotent, so a re-send cannot duplicate
 * or double-apply anything: dry-run/validate/plan computations, CSS re-prime (the `CSS_PRIME_FAILED`
 * retry contract depends on this one), cache regen/flush, and media sideload (replay-safe via the
 * server's source-bytes-hash dedupe). `uploadMedia` is deliberately ABSENT — base64/multipart
 * uploads have no server-side dedupe and would duplicate attachments on retry.
 */
const IDEMPOTENT_NON_GET_ROUTES: ReadonlySet<RouteName> = new Set<RouteName>([
  'dryRunDocument',
  'validateIds',
  'remapIds',
  'batchPlan',
  'primeCss',
  'cacheRegen',
  'cacheFlush',
  'sideloadMedia',
]);

/** True when `body` carries a non-empty string `op_id` the server can replay-match. */
function bodyHasOpId(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) {
    return false;
  }
  const opId = (body as { op_id?: unknown }).op_id;
  return typeof opId === 'string' && opId.length > 0;
}

/**
 * Whether a request may be auto-retried after a transient failure WITHOUT risking a duplicate side
 * effect. A 502/reset/timeout can arrive AFTER the server processed the request, so the client only
 * re-sends: GETs, the inherently idempotent routes, and the replay-protected write routes when the
 * body carries the `op_id` the server dedupes on. Everything else surfaces the transient error to
 * the caller (who can decide to re-send with replay protection).
 */
export function isRetrySafeRequest(method: string, routeName?: RouteName, body?: unknown): boolean {
  if (method.toUpperCase() === 'GET') {
    return true;
  }
  if (routeName === undefined) {
    return false;
  }
  if (IDEMPOTENT_NON_GET_ROUTES.has(routeName)) {
    return true;
  }
  return OP_ID_REPLAY_ROUTES.has(routeName) && bodyHasOpId(body);
}

/* ───────────────────────────────────── client config ────────────────────────────────────── */

/** Retry / backoff tuning (`10-rest-api.md` "exponential backoff with jitter for retryable codes"). */
export interface RetryPolicy {
  /** Max retry attempts AFTER the first try (0 disables retries). */
  maxRetries: number;
  /** Base backoff in ms (doubles each attempt). */
  baseDelayMs: number;
  /** Backoff ceiling in ms. */
  maxDelayMs: number;
}

/** Default retry policy: 3 retries, 250ms base, 5s ceiling. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxRetries: 3,
  baseDelayMs: 250,
  maxDelayMs: 5000,
});

/** Construction options for {@link WpClient}. */
export interface WpClientOptions {
  /** Per-site connection + auth config (`01-architecture.md §6.2`). */
  site: SiteConfig;
  /** Retry policy override (defaults to {@link DEFAULT_RETRY_POLICY}). */
  retry?: Partial<RetryPolicy>;
  /** Injectable `fetch` (defaults to the Node 20 global) — for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep (defaults to a real timer) — for tests to avoid real backoff waits. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/** Options for a single typed request. */
export interface RequestOptions {
  /** Path params substituted into the route's `{...}` placeholders. */
  pathParams?: Record<string, string | number>;
  /** Query params appended to the URL (arrays repeat the key in PHP `key[]` form). */
  query?: Record<string, string | number | boolean | Array<string | number> | null | undefined>;
  /** JSON request body. */
  body?: unknown;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /**
   * Marks this request safe to auto-retry on transient taxonomy codes. When omitted, `request()`
   * computes it via {@link isRetrySafeRequest} (route registry + body `op_id`); a direct `send()`
   * defaults to retrying GETs only. Pass `true` ONLY for calls verified idempotent or server-side
   * replay-protected — a retried non-idempotent write can duplicate its side effect.
   */
  idempotent?: boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Exponential backoff with full jitter, clamped to the ceiling. */
function backoffDelay(attempt: number, policy: RetryPolicy): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}

/* ─────────────────────────────────────── WpClient ───────────────────────────────────────── */

/**
 * The typed Seam-B HTTP client. One instance per target site. `wp/routes.ts` wraps this with one
 * function per route; tool WPs call those wrappers, never this class' low-level methods directly
 * (except for tests / bespoke flows).
 */
export class WpClient {
  private readonly site: SiteConfig;
  private readonly retry: RetryPolicy;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly baseUrl: string;

  constructor(options: WpClientOptions) {
    this.site = options.site;
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
    this.baseUrl = options.site.url.replace(/\/+$/, '');
  }

  /**
   * The auth header(s) injected on every request (`10-rest-api.md §0.2`). PHASE 2 (T1): when the
   * site carries an `mcpApiKey`, authenticate via the additive `X-MCP-API-Key` vector (mapped to the
   * plugin's least-privilege service user); otherwise fall back to `Authorization: Basic <token>`
   * (the standalone/dev default). The client still makes NO trust decisions — AuthN/Z is PHP's.
   */
  private authHeaders(): Record<string, string> {
    const mcpKey = this.site.mcpApiKey;
    if (mcpKey !== undefined && mcpKey !== '') {
      return { 'X-MCP-API-Key': mcpKey };
    }
    return { Authorization: `Basic ${this.site.basicToken ?? ''}` };
  }

  /** Build an absolute URL for an `elementor-ultra/v1/*` route path (already namespace-relative). */
  private restUrl(routePath: string, query?: RequestOptions['query']): string {
    return this.withQuery(`${this.baseUrl}${REST_BASE_PATH}${routePath}`, query);
  }

  /** Build an absolute URL for a core `wp/v2/*` path (e.g. media). `path` is relative to `wp/v2`. */
  wpV2Url(path: string, query?: RequestOptions['query']): string {
    const clean = path.startsWith('/') ? path : `/${path}`;
    return this.withQuery(`${this.baseUrl}/wp-json/wp/v2${clean}`, query);
  }

  private withQuery(url: string, query?: RequestOptions['query']): string {
    if (!query) {
      return url;
    }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined) {
        continue;
      }
      if (Array.isArray(value)) {
        // PHP-style `key[]` repetition (M-d, contract 18 §7): a bare repeated `key` collapses to the
        // LAST value in WP/PHP query parsing, which silently dropped every `fields` entry but one
        // (e.g. `fields=id&fields=label` → `['label']` → the projection lost `id`).
        for (const item of value) {
          params.append(`${key}[]`, String(item));
        }
      } else {
        params.append(key, String(value));
      }
    }
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  /**
   * Typed call to a named `elementor-ultra/v1` route. Returns the unwrapped `data` payload `T`.
   * Throws {@link WpClientError} on an error envelope / transport failure (after the retry policy).
   */
  async request<T>(routeName: RouteName, options: RequestOptions = {}): Promise<T> {
    const def = ROUTES[routeName];
    const routePath = buildRoutePath(routeName, options.pathParams ?? {});
    const url = this.restUrl(routePath, options.query);
    const idempotent =
      options.idempotent ?? isRetrySafeRequest(def.method, routeName, options.body);
    return this.send<T>(def.method, url, { ...options, idempotent });
  }

  /**
   * Low-level send to an absolute URL (used by {@link request} and for `wp/v2/*` calls). Applies the
   * envelope unwrap, error mapping, and retry policy. `T` is the unwrapped `data` shape.
   */
  async send<T>(method: string, url: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      ...this.authHeaders(),
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (options.signal) {
      init.signal = options.signal;
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    // Retry ONLY when the request is safe to re-send (GET / idempotent / op_id-replay-protected,
    // `isRetrySafeRequest`): a transient failure can land AFTER the server applied a write, so a
    // blind re-send of a non-idempotent POST duplicates pages/attachments. Non-retry-safe requests
    // get exactly one attempt and surface the transient error to the caller.
    const retrySafe = options.idempotent ?? isRetrySafeRequest(method);
    const maxRetries = retrySafe ? this.retry.maxRetries : 0;
    let lastError: WpClientError | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await this.attempt<T>(url, init);
      } catch (err) {
        const clientErr = err instanceof WpClientError ? err : this.transportError(err);
        lastError = clientErr;
        if (!isClientRetryable(clientErr.code) || attempt === maxRetries) {
          throw clientErr;
        }
        await this.sleepImpl(backoffDelay(attempt, this.retry));
      }
    }
    /* Unreachable: the loop always returns or throws. */
    throw lastError ?? this.transportError(new Error('Request failed with no result'));
  }

  /**
   * Mark or clear a document's verify-gate quarantine (contract 17 §3). The convert handler calls
   * this when the fidelity gate FAILS (`on=true`) so the WP-side `wp_insert_post_data` lock refuses
   * to PUBLISH the page from ANY source (core REST, wp-admin, the MCP), and CLEARS it (`on=false`)
   * on a passing conversion. Best-effort — callers wrap in try/catch so a marker failure never
   * fails the conversion itself.
   */
  async setQuarantine(postId: number, on: boolean, reason?: string): Promise<void> {
    const url = `${this.baseUrl}${REST_BASE_PATH}/documents/${postId}/quarantine`;
    await this.send('POST', url, {
      body: { on, ...(reason !== undefined ? { reason } : {}) },
      idempotent: true,
    });
  }

  /** A single (non-retried) attempt: fetch, unwrap, or throw a mapped {@link WpClientError}. */
  private async attempt<T>(url: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(url, init);
    const text = await response.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        /* Non-JSON body (e.g. a host error page) — classify as UPSTREAM_ERROR below. */
        if (!response.ok) {
          throw this.upstreamError(response.status, text);
        }
        throw this.upstreamError(response.status, text);
      }
    }

    if (response.ok) {
      return this.unwrapSuccess<T>(parsed);
    }
    throw this.mapErrorEnvelope(parsed, response.status);
  }

  /** Unwrap `{success:true,data}` → `data`; tolerate a bare-payload body as a fallback. */
  private unwrapSuccess<T>(parsed: unknown): T {
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'data' in parsed &&
      (parsed as { success?: unknown }).success === true
    ) {
      return (parsed as { data: T }).data;
    }
    /* Some core wp/v2 routes are not enveloped; pass the body through. */
    return parsed as T;
  }

  /** Map an error-envelope body (or a non-envelope error body) to a typed {@link WpClientError}. */
  private mapErrorEnvelope(parsed: unknown, status: number): WpClientError {
    const envelope = (parsed ?? {}) as {
      code?: string;
      message?: string;
      data?: {
        status?: number;
        op_id?: string;
        errors?: RestFieldErrorLike[];
        meta?: Record<string, unknown>;
      };
    };
    const httpStatus = envelope.data?.status ?? status;
    const code = mapEnvelopeCode(envelope.code, httpStatus);
    const message = envelope.message ?? `Request failed with HTTP ${httpStatus}`;
    const opId = envelope.data?.op_id;
    const fieldErrors = envelope.data?.errors;
    // Fold the per-field validator errors (`data.errors[]`, e.g. the save-path ATOMIC_*_INVALID
    // detail) and the `op_id` into `payload.meta` so the GENERIC tool error path (`formatErrorText`
    // text + `structuredContent`) carries WHICH props failed — without this, agents got only
    // "Element-tree validation failed (N errors)" and had to re-run dry_run to recover detail the
    // server already sent (`12-error-taxonomy.md §2-3`).
    const meta = {
      ...(envelope.data?.meta ?? {}),
      ...(fieldErrors !== undefined && fieldErrors.length > 0 ? { errors: fieldErrors } : {}),
      ...(opId !== undefined ? { op_id: opId } : {}),
    };
    const payload = makeErrorPayload(code, message, {
      http_status: httpStatus,
      meta: meta as never,
    });
    return new WpClientError(payload, {
      httpStatus,
      ...(fieldErrors !== undefined ? { fieldErrors } : {}),
      ...(opId !== undefined ? { opId } : {}),
    });
  }

  /** A transport-layer failure (network/abort) → `UPSTREAM_ERROR` (retryable). */
  private transportError(err: unknown): WpClientError {
    const message = err instanceof Error ? err.message : String(err);
    const payload = makeErrorPayload(ErrorCodes.UPSTREAM_ERROR, `Transport failure: ${message}`, {
      http_status: 0,
      meta: { status: 0, body_excerpt: message },
    });
    return new WpClientError(payload, { httpStatus: 0 });
  }

  /** A non-2xx with an unclassifiable (non-JSON) body → `UPSTREAM_ERROR`. */
  private upstreamError(status: number, body: string): WpClientError {
    const payload = makeErrorPayload(
      ErrorCodes.UPSTREAM_ERROR,
      `Upstream returned HTTP ${status}`,
      {
        http_status: status,
        meta: { status, body_excerpt: body.slice(0, 256) },
      },
    );
    return new WpClientError(payload, { httpStatus: status });
  }

  /**
   * Fetch the NEXT page of a paginated route given a prior page's `next_cursor`. Returns `null` when
   * `cursor` is `null` (last page). This is the ONLY pagination affordance — there is deliberately no
   * unbounded "fetch all pages" helper (`15-engineering-standards.md §2.9`).
   */
  async fetchNextPage<T>(
    routeName: RouteName,
    cursor: string | null,
    options: RequestOptions = {},
  ): Promise<Paginated<T> | null> {
    if (cursor === null) {
      return null;
    }
    const query = { ...(options.query ?? {}), cursor };
    return this.request<Paginated<T>>(routeName, { ...options, query });
  }
}
