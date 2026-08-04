import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { SHARED_PACKAGE_NAME } from './index.js';
import { ERROR_CODES, ERROR_CODE_META, ErrorCodes, isSoftCode } from './errors/codes.js';

// Trivial scaffold test (WP-F01): proves the vitest runner + tsconfig resolve and
// that the package exports a constant. Richer suites are WP-F06 / Q##.
describe('shared scaffold', () => {
  it('exports the package name constant', () => {
    expect(SHARED_PACKAGE_NAME).toBe('@elementor-ultra/shared');
  });
});

/* ─────────────── frozen error-code catalog ⇄ machine-readable JSON (WP-F05/F06) ─────────────── */

interface ErrorCodesJson {
  codes: string[];
  meta: Record<
    string,
    {
      http_status: number;
      retryable: boolean;
      surface: string;
      rpc_code: number | null;
      soft: boolean;
    }
  >;
}

const errorCodesJson = JSON.parse(
  readFileSync(new URL('../schemas/error-codes.json', import.meta.url), 'utf8'),
) as ErrorCodesJson;

describe('error-code catalog (12-error-taxonomy.md §6 + contract 18 §7-AI S1/S2 appendices)', () => {
  it('the TS enum and the machine-readable JSON carry the identical 31-code set', () => {
    expect([...ERROR_CODES]).toEqual(errorCodesJson.codes);
    expect(ERROR_CODES.length).toBe(31);
  });

  it('per-code metadata agrees between the TS table and the JSON', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_CODE_META[code], code).toEqual(errorCodesJson.meta[code]);
    }
  });

  it('SETTINGS_INVALID is a hard 422 validation code (§7-AI S1, kills AF1)', () => {
    expect(ERROR_CODE_META[ErrorCodes.SETTINGS_INVALID]).toEqual({
      http_status: 422,
      retryable: false,
      surface: 'isError',
      rpc_code: null,
      soft: false,
    });
  });

  it('RENDER_FAILED is a soft 200 outcome riding the result (§7-AI S2, kills AF2)', () => {
    expect(ERROR_CODE_META[ErrorCodes.RENDER_FAILED]).toEqual({
      http_status: 200,
      retryable: false,
      surface: 'isError',
      rpc_code: null,
      soft: true,
    });
    expect(isSoftCode(ErrorCodes.RENDER_FAILED)).toBe(true);
  });
});
