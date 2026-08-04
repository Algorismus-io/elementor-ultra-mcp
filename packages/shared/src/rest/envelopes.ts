/**
 * WP-F02 — REST success / error envelope types (Seam B).
 *
 * Verbatim realization of the frozen envelope shapes from
 * `spec/contracts/10-rest-api.md §0.5/§0.6` and `12-error-taxonomy.md §2`. EVERY 2xx response from
 * the companion plugin (`elementor-ultra/v1/*`) is wrapped in {@link RestSuccess}; EVERY non-2xx is a
 * {@link RestError}. The TS client (`packages/server/src/wp/client.ts`, WP-F02) unwraps `data`
 * automatically and maps the error envelope to a typed error carrying a taxonomy code.
 *
 * Contract authority: spec/contracts/10-rest-api.md, spec/contracts/12-error-taxonomy.md.
 * OpenAPI authority: spec/contracts/openapi.yaml#/components/schemas/{SuccessEnvelope,ErrorEnvelope,FieldError}.
 *
 * The `code` field is a stable taxonomy code (WP-F05). The envelope SHAPE is owned here; the concrete
 * `ErrorCode` string-literal union lives in `../errors` (WP-F05); the wire `code` is typed as the open
 * `string` because the plugin may emit `E_`-prefixed REST codes / WP core slugs the client maps to a
 * taxonomy code (see WP-F02 client `mapEnvelopeCode`).
 */

/**
 * One structured per-field error from a multi-error / validation response (`dry-run`, `save`,
 * `batch`). Mirrors `openapi.yaml#/components/schemas/FieldError` and `10-rest-api.md §0.6`.
 *
 * `path` is a JSON-pointer-like dotted path into the request body
 * (e.g. `elements[2].settings.title`). `code` is a taxonomy code (typed loosely as `string` here
 * because PHP may emit per-field codes such as `E_PROP_INVALID` that are narrower than the
 * top-level taxonomy; consumers MAY narrow).
 */
export interface RestFieldError {
  /** Dotted JSON-pointer-like path into the request body, e.g. `elements[0].settings.tag`. */
  path: string;
  /** Stable taxonomy / per-field code (e.g. `E_PROP_INVALID`, `E_STYLE_INVALID`). */
  code: string;
  /** Human-readable message; carries appended parser errors verbatim. */
  message: string;
  /** Code-specific structured context (open object). */
  meta?: Record<string, unknown>;
}

/**
 * The `data` payload of a {@link RestError} envelope (`10-rest-api.md §0.6`,
 * `openapi.yaml#/components/schemas/ErrorEnvelope/properties/data`).
 */
export interface RestErrorData {
  /** HTTP status (also the actual response status line). */
  status: number;
  /** Echoes the request `op_id` when one was supplied. */
  op_id?: string;
  /** Present for multi-error / validation responses (dry-run, save, batch). */
  errors?: RestFieldError[];
  /** Code-specific structured context (open object), e.g. `{ current_base_hash }`. */
  meta?: Record<string, unknown>;
}

/**
 * The standard success envelope. EVERY 2xx response uses this shape
 * (`10-rest-api.md §0.5`, `openapi.yaml#/components/schemas/SuccessEnvelope`). The per-route response
 * interfaces below describe the contents of `data`; the client unwraps `data` automatically.
 */
export interface RestSuccess<T> {
  success: true;
  data: T;
}

/**
 * The standard error envelope. EVERY non-2xx response uses this WordPress-REST-native shape enriched
 * with our taxonomy (`10-rest-api.md §0.6`, `openapi.yaml#/components/schemas/ErrorEnvelope`).
 *
 * `code` is a stable taxonomy code. WordPress core may also surface its own slugs (e.g.
 * `rest_not_logged_in` on 401); the client maps those to taxonomy codes — see WP-F02 client.
 */
export interface RestError {
  /**
   * Stable taxonomy code (WP-F05) OR a WordPress core slug the client maps to one. Typed as the open
   * `string` because the wire may carry `E_`-prefixed REST codes / WP core slugs (e.g.
   * `rest_not_logged_in`) that are mapped to an {@link ErrorCode} by the client; the taxonomy union is
   * the documented subset (see WP-F02 client `mapEnvelopeCode`).
   */
  code: string;
  /** Human-readable summary. */
  message: string;
  data: RestErrorData;
}

/** Discriminated union of the two envelope shapes for a given route payload `T`. */
export type RestResponse<T> = RestSuccess<T> | RestError;

/** Narrowing guard: true when an envelope is the success shape. */
export function isRestSuccess<T>(envelope: RestResponse<T>): envelope is RestSuccess<T> {
  return (envelope as RestSuccess<T>).success === true;
}

/** Narrowing guard: true when an envelope is the error shape. */
export function isRestError<T>(envelope: RestResponse<T>): envelope is RestError {
  return !isRestSuccess(envelope);
}
