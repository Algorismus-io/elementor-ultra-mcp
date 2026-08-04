---
id: WP-H04
title: NORMALIZE stage - block-child promotion, whitespace, URL resolution
layer: html
phase: v1
status: planned
depends_on:
  - WP-F03
  - WP-H01
  - WP-H03
files_owned:
  - packages/server/src/convert/normalize.ts
  - packages/server/src/convert/normalize.test.ts
contract_refs:
  - spec/contracts/11-authoring-contract.md#33-html-v3-inline-only-allowlist-hard-rule
  - spec/contracts/12-error-taxonomy.md#31-validation--authoring
  - spec/contracts/13-tool-catalog.md#19-html-native-conversion-flagship
estimate: M
---

## Summary

The second conversion stage: take the raw IR tree from PARSE and normalize it for native authoring.
The load-bearing job is **promoting block-level children out of `html-v3` inline-only text** into
sibling element nodes (RESEARCH.md §6.2/§6.6, authoring-contract §3.3) — because the atomic `html-v3`
prop strips everything outside the inline allowlist `[b,i,em,u,a,del,span,strong,sup,sub,s]`. It also
collapses whitespace-only text nodes, unwraps redundant single-child wrappers, resolves relative URLs,
and decodes entities. It records every promotion/strip so the coverage report (`stripped_text`) is
honest. NO Elementor I/O, NO classification (that is WP-H05), NO style mapping.

## Interface / Contract

Exports from `packages/server/src/convert/normalize.ts`. `NormalizeContext`, `NormalizeResult`,
`StrippedRecord`, `PromotionRecord` are FROZEN and OWNED by WP-H01 (`convert/types.ts`, Contract 15
§4.6.1); this WP IMPLEMENTS the function and `import type`s them — it does NOT declare them locally.
For reference (the frozen shapes):

- `normalizeIr(ir: IrNode[], ctx: NormalizeContext): NormalizeResult` where:
  - `NormalizeContext = { base_url?: string; raw_inner_markup: Record<string,string>;
    unwrap_redundant: boolean }` (`raw_inner_markup` comes from `ParseResult`, WP-H03).
  - `NormalizeResult = { ir: IrNode[]; stripped: StrippedRecord[]; promotions: PromotionRecord[];
    warnings: string[] }`.
  - `StrippedRecord = { source_path: string; stripped_tags: string[] }` — the verbatim shape consumed
    by the coverage report (`CoverageReport.stripped_text[].stripped_tags`, diff.schema.json) and the
    `HTML_V3_STRIPPED` soft error (error-taxonomy §3.1).
  - `PromotionRecord = { from_source_path: string; promoted_to: string[]; reason: string }`.
- `INLINE_ALLOWLIST: ReadonlySet<string>` — exactly `b,i,em,u,a,del,span,strong,sup,sub,s`
  (`html-v3-prop-type.php:91`, authoring-contract §3.3). Owned here as the single source of truth for
  what survives inside `html-v3`.
- `computeStrippedTags(rawInnerHtml: string): string[]` — given a node's raw inner markup, return the
  set of tag names that the `html-v3` `wp_kses` allowlist would strip (everything not in
  `INLINE_ALLOWLIST`, including `br`, `mark`, `code`, `small`, `font`, lists, nested blocks). This is
  the TS mirror of the PHP strip behavior, used ONLY for reporting (PHP dry_run is still authoritative
  for the final tree).

## Dependencies & Inputs

- **WP-H03 (PARSE)** — consumes `ParseResult.ir` and `ParseResult.raw_inner_markup`.
- **WP-H01** — `IrNode`/`SemanticRole`/`TextRun` IR types.
- **WP-F03** — shared types only (no envelopes yet).
- Contract sections: 11-authoring-contract §3.3 (`html-v3` inline-only allowlist HARD rule; "The
  normalizer MUST promote block content to sibling element nodes BEFORE emitting `html-v3`"); §11
  (content-filter caveats); 12-error-taxonomy §3.1 (`HTML_V3_STRIPPED` soft code: `element_id`,
  `stripped_tags[]`); 13-tool-catalog §1.9 (`report.stripped_text`). RESEARCH.md §6.2 step 2, §6.6.
- Elementor source: `modules/atomic-widgets/prop-types/html-v3-prop-type.php:82,91` (the `wp_kses`
  allowlist) — for grounding the allowlist set only.

## Detailed Requirements

1. **Block-child promotion (primary).** For any text-bearing node whose raw inner markup contains
   block-level or non-allowlisted tags (e.g. a `<p>` containing a nested `<div>`, `<ul>`, `<h3>`,
   `<br>`, `<code>`, `<small>`), SPLIT it: keep the inline-allowlisted runs as the text node's
   `html-v3` content, and PROMOTE each block child to a sibling `IrNode` (e.g. a nested `<div>` becomes
   a sibling `structural-block` node, a nested heading becomes a sibling heading node, list items
   become sibling list nodes). Record a `PromotionRecord`. After promotion, a text node's surviving
   inner markup MUST contain only `INLINE_ALLOWLIST` tags.
2. **Stripped-tag accounting.** For every text node, compute `computeStrippedTags` from its raw inner
   markup and, for any tag that is neither promoted nor in the allowlist (e.g. `<br>`, `<mark>`,
   `<font>`), record a `StrippedRecord`. `<br>` handling: prefer converting `<br>` to a structural
   line break (split into sibling paragraphs) when it separates blocks; when it is a trivial inline
   break inside running text, record it as stripped (it is not in the allowlist) and note the loss.
   Do NOT silently lose anything without a `StrippedRecord`.
3. **Whitespace collapse.** Collapse runs of whitespace in non-`<pre>` text to a single space; drop
   whitespace-only text nodes between block elements; trim leading/trailing whitespace of text runs.
   Respect `white-space: pre*` computed values (do not collapse) — read from `IrNode.computed`
   (`white-space` is NOT a Style-Schema prop, authoring-contract §5.2, but PARSE may still have it if
   whitelisted; if absent, default to collapse and note).
4. **Redundant-wrapper unwrap.** When `unwrap_redundant:true`, collapse a wrapper element that has
   exactly one child, no own non-default styles, and no semantic role (e.g. a bare `<div>` wrapping a
   single `<div>`) by hoisting the child and MERGING any non-conflicting styles. NEVER unwrap a node
   that carries flex/grid layout, a background, padding/margin, or a semantic tag — it would lose
   layout (the "5+ nested divs reduce accuracy" failure, SUPPLEMENT §C.1). Conservative by default.
5. **URL resolution.** Resolve relative URLs in `IrNode.media` and link `attrs.href` against
   `base_url` when provided; decode HTML entities in text runs and attribute values. Leave absolute
   URLs untouched. Media refs stay un-sideloaded (sideload is WP-H08).
6. **Entity decode.** Decode named/numeric HTML entities in `textRuns[].text` so the eventual
   `html-v3` content carries decoded characters (PHP `wp_kses` will re-encode as needed).
7. Pure transform: deterministic, no I/O, no Playwright, no WP client. Idempotent — running
   `normalizeIr` on an already-normalized tree changes nothing and produces empty `stripped`/
   `promotions`.
8. Do NOT classify roles here beyond what PARSE already set; do NOT map to Elementor types; do NOT wrap
   envelopes. Output is still IR.

## Implementation Notes

- The allowlist is exactly `[b,i,em,u,a,del,span,strong,sup,sub,s]` — copy it verbatim from
  `html-v3-prop-type.php:91`. Anything else inside text is stripped by PHP; the report must reflect
  this so the agent can decide to restructure the source.
- Promotion ordering matters: when a `<p>` is `text [block] text`, produce three siblings (text-para,
  block, text-para) preserving document order so layout reads top-to-bottom.
- `computeStrippedTags` is REPORT-ONLY. The actual `html-v3` value is built in STYLE-EXTRACT/ASSEMBLE
  and validated by PHP dry_run (authoritative). Never claim a tree is valid based on this TS mirror.
- Round-trip caveat (authoring-contract §11): admins are exempt from content-sanitizer `title`
  rewriting; non-admins are not. NORMALIZE does not need to know the user role, but its stripped-text
  accounting must align with the inline allowlist (which applies regardless of role) so round-trip
  identity tests (Contract 14 §7) don't show spurious diffs.

## Acceptance Criteria

- [ ] A `<p>` containing a nested `<div>` is split into sibling nodes; the surviving text node's inner
      markup contains only allowlisted inline tags; a `PromotionRecord` is produced.
- [ ] `<mark>`, `<code>`, `<small>`, `<font>` inside text produce `StrippedRecord`s with the correct
      `stripped_tags`.
- [ ] `<br>` between blocks splits into siblings; inline `<br>` is recorded as stripped.
- [ ] Whitespace-only text nodes between blocks are removed; `pre` content is not collapsed.
- [ ] A single-child styleless `<div>` wrapper is unwrapped when `unwrap_redundant:true`; a flex/
      padded/background wrapper is NEVER unwrapped.
- [ ] Relative media/href URLs resolve against `base_url`; entities decode.
- [ ] `normalizeIr` is idempotent (second pass yields empty `stripped`/`promotions`).
- [ ] `INLINE_ALLOWLIST` equals exactly the 11 tags from `html-v3-prop-type.php:91` (snapshot test).

## Tests Required

- Unit (`normalize.test.ts`): block-child promotion (mixed text+block `<p>`); stripped-tag accounting
  for each non-allowlisted tag; `<br>` block-vs-inline; whitespace collapse + `pre` preservation;
  redundant-wrapper unwrap (safe vs unsafe); URL/entity resolution; idempotence; allowlist snapshot.
- Contract: assert `StrippedRecord` field names match `CoverageReport.stripped_text` item shape in
  `diff.schema.json` (load the schema in the test).

## Parallelization Notes

- Parallel-safe with all sibling HTML WPs: owns only `normalize.ts` + test.
- Type dependency on WP-H01 ONLY: `ParseResult`, `NormalizeResult`, `StrippedRecord`, `PromotionRecord`,
  `IrNode` are all frozen in WP-H01 `types.ts` (Contract 15 §4.6.1). This WP is therefore buildable and
  unit-testable the moment WP-H01 lands — it codes `normalizeIr` against the frozen `ParseResult` input
  and `NormalizeResult` output and tests with hand-authored IR fixtures. It needs WP-H03's RUNTIME only
  for end-to-end corpus tests (owned by WP-H10/Q04), NOT to compile or unit-test. (The DAG still
  sequences it after WP-H03 to keep the corpus chain linear, but the contract dependency is on WP-H01.)
