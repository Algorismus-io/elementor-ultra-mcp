---
id: WP-H08
title: ASSEMBLE stage - build atomic tree, mint IDs, sideload media, wrap envelopes
layer: html
phase: v1
status: planned
depends_on:
  - WP-F03
  - WP-F05
  - WP-P02
  - WP-P03
  - WP-P05
  - WP-P06
  - WP-H01
  - WP-H06
  - WP-H07
  - WP-S01
files_owned:
  - packages/server/src/convert/assemble.ts
  - packages/server/src/convert/assemble.test.ts
contract_refs:
  - spec/contracts/11-authoring-contract.md#2-the-two-coexisting-node-schemas
  - spec/contracts/11-authoring-contract.md#32-image-src-is-id-xor-url-hard-rule
  - spec/contracts/11-authoring-contract.md#51-local-style-id-mirroring-into-classes-hard-rule
  - spec/contracts/11-authoring-contract.md#81-id-uniqueness-handling
  - spec/contracts/10-rest-api.md#media
  - spec/contracts/schemas/element-node.schema.json
estimate: L
---

## Summary

The sixth conversion stage: turn the styled, mapped IR into a concrete `ElementNode[]` tree (WP-F03 /
element-node.schema.json) — minting unique 7-hex element ids and unique local-style ids, MIRRORING
local-style ids into `settings.classes` (authoring-contract §5.1), sideloading every image and
background-image via `media.sideload_url` then emitting `image-src` ID-ONLY (authoring-contract §3.2),
and wrapping every settings/style value in its typed envelope via WP-F03 `envelopes.ts`. The output is
a tree ready for HOIST (WP-H09) and the authoritative PHP `dry_run`. ASSEMBLE persists nothing itself
beyond media sideload; it is atomic-CSS-affecting (it produces atomic styles) so it depends on the PHP
dry_run validator + prime-css + WP-S01 per the universal rules.

## Interface / Contract

`AssembleContext`, `AssembleResult`, `SideloadError`, `MediaPort`, `IdPort`, and the consumed
`StyledNode` are FROZEN and OWNED by WP-H01 (`convert/types.ts`, Contract 15 §4.6.1); this WP IMPLEMENTS
the function and `import type`s them — it does NOT declare them locally. `ElementNode`/`StyleDefinition`
are WP-F03 shared types. For reference (the frozen shapes):

Exports from `packages/server/src/convert/assemble.ts`:

- `assembleTree(styled: StyledNode[], ctx: AssembleContext): Promise<AssembleResult>` where:
  - `AssembleContext = { generation:'v4'|'v3'; existing_ids: Set<string>; sideload_media: boolean;
    media: MediaPort; ids: IdPort }`. `MediaPort` wraps the `media.sideload_url`/`media.upload` REST
    calls (10-rest-api §Media, `POST /media/sideload`); `IdPort` wraps WP-F03 `ids.ts` minting/dedupe
    and (optionally) the `ids/validate` REST call for cross-document collision checks
    (authoring-contract §8.1).
  - `AssembleResult = { elements: ElementNode[]; media_map: Record<string,number>;
    sideload_errors: SideloadError[]; minted_ids: string[]; local_style_ids: string[] }`.
- The produced `elements` are FULL `ElementNode`s (atomic container/widget per element-node.schema.json):
  `{id, elType, version:'0.0', settings:{...envelopes...}, styles:{<id>:StyleDefinition},
  editor_settings, interactions:[], elements:[...]}` for atomic; classic shape for v3 fallback nodes.

## Dependencies & Inputs

- **WP-P03 (PHP dry_run validator)** — REQUIRED (universal write rule). The assembled tree is the input
  to the authoritative `dry_run`; this WP must produce a tree shaped exactly to pass it (no raw values,
  id-XOR-url images, mirrored local styles). The orchestrator (WP-H11) runs the dry_run.
- **WP-P06 (media controller)** — `media.sideload_url`/`media.upload`/`media.list` (10-rest-api §Media,
  `class-media-controller.php`). ASSEMBLE calls sideload to import `<img>`/background images and gets
  back `{attachment_id,url,sizes}`; dedupe by source-hash is the plugin's job (RESEARCH.md §5.5).
- **prime-css WP (WP-P05 `includes/core/class-css-primer.php`, `Css_Primer`) + WP-S01** — REQUIRED
  (universal atomic-CSS rule): the atomic styles assembled here only render after priming; the
  orchestrator (WP-H11) primes post-save via the WP-P05 service.
- **WP-H07 (STYLE-EXTRACT)** — consumes `StyledNode[]` (mapped IR + local styles + media-pending markers).
- **WP-H06 (MAP)** — target types + `settings_seed` flow through `StyledNode`.
- **WP-H01** — IR types.
- **WP-F03** — `ElementNode`/`AtomicContainerNode`/`AtomicWidgetNode`/`ClassicNode`, `envelopes.ts`
  (typed-value wrappers), `ids.ts` (7-hex mint + dedupe), `Image`/`ImageSrc` types.
- **WP-F05** — error codes for sideload/validation surfacing (`MEDIA_TYPE`/`IMAGE_SRC_XOR_VIOLATION`/
  `LOCAL_STYLE_UNLINKED`).
- Contract sections: 11-authoring-contract §2 (node schemas), §3.2 (image-src id-XOR-url HARD),
  §5.1 (local-style mirroring HARD), §8.1 (id uniqueness/remap); 10-rest-api §Media; element-node.schema.json.
  RESEARCH.md §6 step 6 (ASSEMBLE), §5.5 (media).

## Detailed Requirements

1. **ID minting + dedupe (authoring-contract §8.1, R3).** Mint each element id via WP-F03 `ids.ts`
   (`substr(strtolower(dechex(wp_rand(...))),0,7)`), deduping against `ctx.existing_ids` and within the
   tree. Optionally call `ids/validate` (via `IdPort`) for the target document's used-id set to avoid
   cross-document collision. Record `minted_ids`. Duplicate ids collide on `.elementor-element-<id>` —
   uniqueness is mandatory (`DUPLICATE_ELEMENT_ID`, error-taxonomy §3.1).
2. **Local-style finalization + mirroring (authoring-contract §5.1, HARD).** For each node's
   `local_styles` (from WP-H07), assign the final id `e-<elementId>-<7hex>` using the now-minted element
   id, write it into the node's `styles` map keyed by that id, AND add that id into the node's
   `settings.classes.value` array. If a local-style id is in `styles` but NOT in `classes`, the style
   silently detaches — this WP MUST enforce the mirror (and a TS pre-check flags `LOCAL_STYLE_UNLINKED`
   before dry_run). Record `local_style_ids`.
3. **Media sideload -> id-only image-src (authoring-contract §3.2, HARD).** When `sideload_media:true`,
   for each `IrNode.media` of kind `img`/`background`, call `media.sideload_url({url,alt,title})`,
   receive `{attachment_id}`, and emit the `image` typed value with `src.image-src.id` ONLY (NO `url`)
   — `($has_id xor $has_url)` (`image-src-prop-type.php:36-44`). For TRUE externals (sideload disabled
   or sideload failed and the agent opted to keep external), emit `url`-only. NEVER both, never neither.
   For background images, sideload then set the atomic `background` image-overlay's image src id-only.
   Record `media_map` (source url -> attachment id) and `sideload_errors` (non-fatal; the node falls
   back to url-only or a placeholder with a recorded reason).
4. **Envelope wrapping (authoring-contract §3).** Wrap every `settings_seed` value and every style prop
   value into its typed envelope `{$$type:<get_key()>, value:<payload>}` using WP-F03 `envelopes.ts`.
   Special cases: `classes` value is a BARE string array (no inner wrap, authoring-contract §3); UNION
   members emit the chosen member's own envelope (never double-wrapped); `html-v3` content is the
   `{content:{$$type:string,value}, children:[]}` shape from the NORMALIZE-produced inline runs.
5. **Node assembly.** Build the full atomic node per element-node.schema.json: container without
   `widgetType`, widget with `{elType:'widget', widgetType:'e-*'}`, `version:'0.0'`, `editor_settings`
   (carry the suggested name into `editor_settings.title` for editor legibility), `interactions:[]`,
   recursive `elements`. For v3 fallback nodes, build the classic flat-settings shape (no styles map;
   settings carry control values + suffix-key responsive). Tolerate `_cssid` on round-trip (do not
   author it).
6. **Tabs structural integrity.** For `e-tabs` family nodes, ensure each `e-tab` in `e-tabs-menu` has a
   matching `e-tab-content` in `e-tabs-content-area` (count + pairing), with linked tab ids
   (authoring-contract §4 note "tab & content counts MUST match").
7. **Link prop.** Build the `link` typed value `{destination:<url envelope>, isTargetBlank:<bool>,
   tag:{$$type:string,value:'a'}}` from the MAP seed (authoring-contract §3.1 `link`).
8. **Async + ordered.** Sideload calls are async; preserve document order; batch/parallelize sideloads
   with bounded concurrency. The function is async (returns a Promise) because of media I/O — this is
   the FIRST convert stage that touches the WP (via the injected `MediaPort`/`IdPort`); keep those
   PORTS injected so the unit tests can stub them (no direct WP client import).
9. Do NOT hoist global classes or create variables (WP-H09). Do NOT persist the document (WP-H11 / the
   PHP save route). Do NOT prime CSS (orchestrator). ASSEMBLE produces a complete, dry-run-ready tree
   with only LOCAL styles + sideloaded media.

## Implementation Notes

- Order: mint element ids FIRST (so local-style ids `e-<elementId>-<7hex>` are derivable), then build
  styles map + mirror into classes, then sideload + image-src, then wrap envelopes. Document this
  ordering so WP-H07's placeholder local-style ids are finalized here consistently.
- Use the injected `MediaPort`/`IdPort` so ASSEMBLE is unit-testable without a live WP — the
  orchestrator (WP-H11) provides real implementations backed by `wp/routes.ts` (WP-T02). This keeps the
  file's only WP dependency behind an interface (parallel-safe).
- image-src id-XOR-url is the single most common rejection (authoring-contract §3.2) — assert the
  invariant in code before returning, and surface `IMAGE_SRC_XOR_VIOLATION` if a node would violate it.
- Sideload dedupe is the plugin's responsibility (source-hash meta, RESEARCH.md §5.5); ASSEMBLE may
  pass the source url through and trust the plugin to dedupe, but should still cache within one
  conversion run (don't sideload the same url twice in one tree).
- `editor_settings` for a container is `[]` (array) per the §2.1 example; for a widget it is an object
  (e.g. `{title:'My Heading'}`). Match the element-node.schema.json shapes.

## Acceptance Criteria

- [ ] Every produced element has a unique 7-hex id (no collisions in-tree, none against `existing_ids`).
- [ ] Every local-style id present in a node's `styles` map is ALSO present in that node's
      `settings.classes.value` (mirroring enforced); a pre-check flags `LOCAL_STYLE_UNLINKED` otherwise.
- [ ] An `<img>` produces an `image` value with `src.image-src.id` only and NO `url` (id-XOR-url); a
      true external (sideload off) produces `url`-only; neither both nor neither ever occurs.
- [ ] A background-image sideloads and sets the atomic `background` image-overlay src id-only.
- [ ] Every settings/style value is a valid typed envelope; `classes` is a bare string array; `html-v3`
      uses the `{content,children}` shape.
- [ ] `e-tabs` output has matching tab/content counts with linked ids.
- [ ] The produced `elements` validate against `element-node.schema.json` (structural) and a
      representative tree round-trips `valid:true` through PHP dry_run (corpus test, Contract 14 §6).
- [ ] `MediaPort`/`IdPort` are injected (no direct WP-client import in `assemble.ts`); unit tests stub
      them.
- [ ] Sideload failure is non-fatal: recorded in `sideload_errors`, node degrades to url-only/placeholder.

## Tests Required

- Unit (`assemble.test.ts`, stubbed `MediaPort`/`IdPort`): id minting/dedupe; local-style mirroring;
  image sideload -> id-only image-src; background image; envelope wrapping (incl. bare `classes`, union
  non-double-wrap, html-v3 shape); tabs pairing; link prop; sideload-failure degradation; structural
  validation against `element-node.schema.json`.
- Contract: assembled trees from `fixtures/html/sections/**` round-trip `valid:true` through PHP dry_run
  (asserted in WP-H10's corpus suite, Contract 14 §6 step 5) and through the TS pre-filter (WP-F03).

## Parallelization Notes

- Parallel-safe with all sibling HTML WPs: owns only `assemble.ts` + test.
- Type/code dependencies: WP-H01 (frozen `AssembleContext`/`AssembleResult`/`SideloadError`/`MediaPort`/
  `IdPort`/`StyledNode` types, Contract 15 §4.6.1), WP-H06 (mapped IR), WP-H07 (styled IR), WP-F03
  (envelopes/ids/`ElementNode`). Contract/code dependencies on WP-P03 (validator), WP-P05 prime-css
  (`Css_Primer`), WP-P06 (media), WP-S01 are satisfied via injected ports + the orchestrator (WP-H11);
  no PHP source is imported. Buildable + unit-testable (stubbed ports) as soon as WP-H01 lands; the DAG
  sequences it after WP-H07 to keep the corpus chain linear.
