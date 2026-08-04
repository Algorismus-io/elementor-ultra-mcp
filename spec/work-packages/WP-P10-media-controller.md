---
id: WP-P10
title: Media REST controller (list/search, sideload external URL with dedupe, raw/base64 upload)
layer: php
phase: MVP
status: planned
depends_on: [WP-P02]
files_owned:
  - plugin/elementor-ultra-mcp/includes/rest/class-media-controller.php
contract_refs:
  - spec/contracts/10-rest-api.md §5 (MEDIA routes), §0.3 (CAP_UPLOAD), §0.11 (pagination)
  - spec/contracts/11-authoring-contract.md §3.2 (image-src id-only for internal media)
  - spec/contracts/12-error-taxonomy.md §3.1/§3.5 (E_MEDIA_TYPE→via mapping, NOT_FOUND)
estimate: M
---

## Summary

The media library surface the HTML pipeline and image authoring depend on: list/search attachments, sideload an external URL into the library (with source-hash dedupe so re-imports don't duplicate), and upload raw bytes / base64. Sideload is NORMATIVE for the converter — `convert.*` sideloads every `<img>`/background-image FIRST and then emits `image-src` ID-ONLY for internal media (Contract 11 §3.2).

## Interface / Contract

Registers (Contract 10 §5):

- `GET /media` (CAP_READ) — list/search; `query?`,`mime?`, pagination → `{items:[{attachment_id,url,title,alt,mime,sizes}],next_cursor,total}`. (§5.1)
- `POST /media/sideload` (CAP_UPLOAD) — `{url,alt,title,op_id}` → `{attachment_id,url,sizes,deduped}`. (§5.2)
- `POST /media/upload` (CAP_UPLOAD) — `multipart/form-data` (file part `file`) OR JSON `{data:<base64>,filename,alt,op_id}` → `{attachment_id,url,sizes}`. (§5.3)

## Dependencies & Inputs

- WP-P02 (`Abstract_Controller`, `Permissions::can_read`/`can_upload`, `Error`, `Pagination`, `read_op_id`).
- Elementor / WP APIs (cite `path:line`):
  - `media_handle_sideload()` (WP core, requires `wp-admin/includes/{media,file,image}.php`) for sideload.
  - `media_handle_upload()` / `wp_handle_upload()` for raw upload; `wp_upload_bits()` for base64.
  - `wp_get_attachment_image_src` / `wp_get_attachment_metadata` for `sizes`.
  - `get_allowed_mime_types()` / `wp_check_filetype_and_ext()` for mime gating.
  - Dedupe: store a source hash on the attachment as meta `_elementor_source_image_hash` (RESEARCH.md §5.5) — match the convention used by Elementor's image import so re-imports dedupe.
- Contract 10 §5 (route shapes), §0.3 (CAP_UPLOAD), §0.11 (pagination). Contract 11 §3.2 (sideload-first; image-src id-only for internal media). Contract 12 (`MEDIA_TYPE` for disallowed mime → REST surfaces `E_MEDIA_TYPE`; `NOT_FOUND`).

## Detailed Requirements

1. **list** (§5.1): query attachments via `WP_Query`/`get_posts` (`post_type=attachment`); `query` searches title/filename; `mime` filters; paginate; return `sizes` map per item. CAP_READ.
2. **sideload** (§5.2): require `url`; download via `media_handle_sideload` (load the admin includes first). Set `alt`/`title` post-import. **Dedupe**: compute a hash of the source (URL hash and/or downloaded-bytes hash); before importing, query existing attachments by `_elementor_source_image_hash`; if found, return the existing attachment with `deduped:true` and DO NOT re-import. On a fresh import, store the hash meta and return `deduped:false`. Reject disallowed mimes with 422 `MEDIA_TYPE` (mapped to `E_MEDIA_TYPE`). Bad/unreachable URL → 400 `BAD_REQUEST`.
3. **upload** (§5.3): accept multipart (`file`) OR JSON base64 (`{data,filename}`). For base64, decode and `wp_upload_bits($filename,null,$bytes)` then `wp_insert_attachment` + `wp_generate_attachment_metadata`. Validate mime via `wp_check_filetype_and_ext`; disallowed → 422 `MEDIA_TYPE`; malformed body → 400. Set `alt`.
4. **sizes**: every response includes the registered image `sizes` (`full`,`large`,...) with url+dimensions so the converter/image authoring can pick a size (Contract 11 §3.1 image prop `size`).
5. **op_id + op-log**: sideload/upload record `op_id` + op-log row (WP-P14, guarded).
6. **No raw element writes**: this controller only manages attachments; it never writes element trees (the converter/authoring tools consume the returned `attachment_id`).

## Implementation Notes

- `media_handle_sideload` requires `require_once ABSPATH . 'wp-admin/includes/media.php'` (+ `file.php`, `image.php`) — do this inside the handler (REST requests don't load admin includes).
- Dedupe hash convention: prefer hashing the downloaded file bytes (robust to URL query-string churn) and storing it as `_elementor_source_image_hash`; also store the source URL as `_elementor_source_image_url` for diagnostics. Match Elementor's convention so the converter and Elementor's own importer agree.
- For base64 uploads, validate size and mime BEFORE writing to disk; reject SVGs unless `unfiltered_html`/SVG support is enabled (note in `warnings`/`MEDIA_TYPE`).
- Return `attachment_id` (int) — the authoring `image-src` id-only envelope (`{$$type:'image-attachment-id',value:<id>}`) consumes it (Contract 11 §3.2).

## Acceptance Criteria

- [ ] `GET /media` lists/searches attachments with `sizes` and paginates.
- [ ] `POST /media/sideload` imports an external URL, returns `attachment_id`+`sizes`, and on re-import of the same source returns the SAME attachment with `deduped:true`.
- [ ] A disallowed mime on sideload/upload returns 422 `MEDIA_TYPE`; a bad URL returns 400.
- [ ] `POST /media/upload` accepts both multipart and base64 and creates an attachment with generated metadata.
- [ ] All routes gate on `upload_files` (write) / `edit_posts` (list).
- [ ] PHPCS clean.

## Tests Required

- PHPUnit (wp-env): `test_media_list_search_paginate`; `test_sideload_imports_and_sets_alt`; `test_sideload_dedupes_by_source_hash`; `test_sideload_bad_url_400`; `test_upload_base64_creates_attachment`; `test_upload_disallowed_mime_422`.
- Fixture: a small test image under the PHP test fixtures (not the shared fixtures dir) for sideload/upload.

## Parallelization Notes

- Wave-2 vertical. Owns ONLY `class-media-controller.php` — disjoint from all other controllers.
- No validator/writer dependency (it does not touch element trees), so it does NOT list WP-P03/P04 — it is not a tree-WRITE WP (it writes attachments via core WP APIs). Depends only on WP-P02.
- Parallel-safe with every other WP-P##. The HTML pipeline (WP-H##) depends on this controller's frozen sideload route.
