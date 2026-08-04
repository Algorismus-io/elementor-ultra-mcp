---
id: WP-T08
title: TS tool handlers — media (sideload_url, upload, list)
layer: ts
phase: v1
status: planned
depends_on: [WP-F01, WP-F02, WP-F04, WP-F05, WP-T01, WP-P10]
files_owned:
  - packages/server/src/tools/media.ts
  - packages/server/src/tools/media.test.ts
contract_refs:
  - spec/contracts/13-tool-catalog.md §1.5 (media/library)
  - spec/contracts/10-rest-api.md §5 MEDIA (sideload dedupe, upload, list)
  - spec/contracts/12-error-taxonomy.md §3 (MEDIA type), §5
estimate: S
---

## Summary

Implements the HANDLERS for the media tool group (Contract 13 §1.5) and attaches them to the WP-F04 registry: `media.sideload_url`, `media.upload`, `media.list`. `media.sideload_url` is the lean ★ tool the HTML pipeline depends on (sideload external images → library, deduped by source hash → emit `image-src` id-only). Thin proxies over the companion media routes; the security boundary (`CAP_UPLOAD`) + mime validation are PHP (WP-P10).

## Interface / Contract

Attaches `ToolHandler`s; schemas owned by WP-F04 (Contract 13 §1.5):

- `media.sideload_url` ★ (M, `POST /media/sideload`) — `{url,alt?,title?}` → `{attachment_id,url,sizes,deduped}`. `idempotentHint` (dedupe by `_elementor_source_image_hash`).
- `media.upload` (M, `POST /media/upload`) — `{data(base64),filename,alt?}` → `{attachment_id,url}`.
- `media.list` (R, `GET /media`) — `{query?,mime?,...page}` → `{items[],next_cursor,total}`.

## Dependencies & Inputs

- WP-T01 (`ToolContext`/`ToolHandler`). Code.
- WP-F02 (`WpRoutes.sideloadMedia`/`uploadMedia`/`listMedia`). Code via `ctx.wp`.
- WP-F04 (catalog + `attachHandler`), WP-F05 (`toMcpResult`). Code.
- WP-P10 (PHP media controller) — runtime counterpart (contract dependency).
- Contract 13 §1.5, §0.6 (pagination). Contract 10 §5.1 (list), §5.2 (sideload dedupe + `image-src` id-only NORMATIVE for HTML pipeline), §5.3 (upload base64/multipart). Contract 12 §3 (`E_MEDIA_TYPE`), §5.

These are M/R. `sideload_url`/`upload` write to the media library but do NOT author Elementor element trees → NOT subject to the LOCKED dry_run rule (Contract 10 §0.9 scopes it to element-tree/kit writes). No prime-css/S01 dependency. PHP still enforces `CAP_UPLOAD` + mime.

## Detailed Requirements

1. Attach handlers for all three §1.5 tools; ★: `media.sideload_url` (Contract 13 §5.2).
2. `media.sideload_url`: proxy `POST /media/sideload`; PHP dedupes by `_elementor_source_image_hash` and returns `deduped` (Contract 10 §5.2). `idempotentHint:true` (dedupe makes a repeat a no-op). Return `{attachment_id,url,sizes,deduped}`.
3. `media.upload`: base64 `data`+`filename` JSON body (Contract 10 §5.3); return `{attachment_id,url}`.
4. `media.list`: paginate `{limit,cursor,fields}`→`{items,next_cursor,total}`; pass `query`/`mime` (Contract 10 §5.1); never unbounded.
5. Errors: disallowed mime → `E_MEDIA_TYPE` (PHP) → isError taxonomy result; bad/unreachable url → `E_BAD_REQUEST`. Arg failures `-32602`.
6. NORMATIVE for the HTML pipeline (Contract 10 §5.2): `media.sideload_url` is the path `convert.*` (WP-H##) uses to import every `<img>`/`background-image` FIRST so it can emit `image-src` ID-only (id-XOR-url, Contract 11 §3.2). This WP exposes it; convert orchestrates.
7. No `any`; strict TS; responses validated via WP-F02.

## Implementation Notes

- Thin handlers: validate-by-SDK → `ctx.wp.<method>` → return. Dedupe/mime/size generation are PHP-side; reflect `deduped` honestly.
- Large base64 uploads: rely on PHP/host limits; surface `RATE_LIMITED`/`UPSTREAM_ERROR` on 413/429.
- `sizes` = `Record<string,{url,width,height}>` (Contract 13 §1.5).

## Acceptance Criteria

- [ ] Handlers attached for all three §1.5 tools; `media.sideload_url` ★.
- [ ] `sideload_url` returns `{attachment_id,url,sizes,deduped}` and is `idempotentHint:true`.
- [ ] `upload` sends base64 JSON; `list` paginates with `query`/`mime`.
- [ ] mime/url errors → taxonomy isError; arg errors `-32602`.
- [ ] No `any`; strict `tsc` + lint clean.

## Tests Required

- `tools/media.test.ts` (vitest, no WP): mock `ctx.wp`; assert I/O shapes vs Contract 13; `deduped` passthrough; pagination; mime/url error rendering.

## Parallelization Notes

- Owns only `tools/media.ts` + test — disjoint from every other `tools/*`.
- Phase v1, Wave 2. Depends on WP-T01 + WP-F02/F04/F05 + WP-P10 (no spike/dry_run gate — media is not an element-tree write). Parallel-safe with all handler WPs. Consumed by WP-H## convert for image sideloading.
