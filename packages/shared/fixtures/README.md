# Golden fixtures + contract-test corpus

This directory is the **single copy** of every golden tree, schema baseline, HTML-corpus
section, round-trip case, and MCP-Inspector smoke payload (Contract 14
[`spec/contracts/14-fixtures-harness.md`](../../../spec/contracts/14-fixtures-harness.md) §1).
Both the TypeScript runner (vitest) **and** the PHP runner (PHPUnit / wp-env) read this exact
directory, so the TS server and the PHP companion plugin can never disagree about a fixture's
verdict.

Owned by **WP-F06**. Other WPs (WP-Q01..Q05, WP-Q04, WP-Q02) **ADD** fixture files in disjoint
paths only — they never edit the loaders/runners or another WP's fixtures (§11 parallel-build
guarantee).

## Layout (LOCKED — §1)

```
packages/shared/fixtures/
├─ envelope.schema.json          # the fixture envelope JSON Schema (§2) — validated by fixtures:validate
├─ corpus.manifest.json          # HTML-corpus section → S3-anchored thresholds (§6); empty here, filled by WP-Q04
├─ trees/                        # (a) golden element-tree fixtures
│  ├─ v4/{valid,invalid}/        # atomic V4 trees — one+ per atomic widget (WP-Q01 adds)
│  ├─ v3/{valid,invalid}/        # classic V3 trees
│  └─ design/                    # diff-PUT / design-system / settings-merge fixtures
├─ schemas/                      # (b) snapshot of live get_props_schema() per widget (drift baseline; WP-F06 snapshot script, WP-Q02 drift job)
├─ html/                         # (d) HTML→native corpus sections (WP-Q04 adds)
├─ roundtrip/                    # (e) build→get_structure→normalize identity fixtures
└─ envelopes/                    # (c) Inspector smoke payloads — smoke.<full.tool.name>.json
```

Naming (LOCKED): `<elementType-or-scenario>.<variant>.json` for trees; `<widgetType>.schema.json`
for schema snapshots; `smoke.<full.tool.name>.json` for Inspector payloads.

## The envelope (§2)

Every fixture is one JSON object validated against [`envelope.schema.json`](./envelope.schema.json):

- `$fixture` (=1), `id` (== filename minus `.json`), `kind` (`tree|design|html|roundtrip|smoke`),
  `generation` (`v4|v3|mixed`), `title`.
- `expect.valid` — the **PHP `dry_run` verdict** (the single source of truth, §3). When
  `valid:false`, `expect.errors[]` carries the expected **SCREAMING_SNAKE_CASE taxonomy codes**
  ([`12-error-taxonomy.md`](../../../spec/contracts/12-error-taxonomy.md) §3/§6) — **never** raw
  Elementor throw-message strings. The envelope `enum` enforces this: a bare throw string fails
  `pnpm fixtures:validate`.
- `requires.{experiments,pro,min_elementor}` — capability gates; a fixture whose `requires` are
  unmet on the target install is **skipped** (not failed) by both loaders.
- `tree[]` — `ElementNode` array (Contract 11), validated against the authoring schemas.
- `prefilter.verdict` — `accept|reject|defer` (§4). Corpus meta-invariant: `accept ⇒ valid:true`,
  `reject ⇒ valid:false`.
- `merge_regression` — optional settings deep-merge regression block
  ([S04/C3/R3] spike correction) consumed by the dry-run/settings suite.

## Typed envelopes are mandatory ([R8])

The authoritative Elementor 4.1.1 validator **rejects bare strings**. Every atomic prop value in a
fixture is a typed envelope `{"$$type","value"}` whose `$$type` equals the prop's `get_key()`
(11-authoring-contract.md §3): a tag is `{"$$type":"string","value":"h1"}` (not `"h1"`), a title is
the `html-v3` envelope, a local-style label is ≥2 chars. The seeded `invalid/` fixtures freeze the
verified failures (`bad-tag-enum`, `bare-string-props`, `label-too-short`, `id-not-in-classes`).

## Scripts (§10)

- `node scripts/fixtures-validate.mjs` (wired as `pnpm fixtures:validate`) — schema-validates every
  fixture against the envelope + the embedded `tree[]` against the authoring schemas. Pure Node, no
  WordPress.
- `node scripts/fixtures-snapshot-schemas.mjs` (wired as `pnpm fixtures:snapshot-schemas`) —
  regenerates the `schemas/*.schema.json` drift baseline from a **live** wp-env install (manual,
  reviewed; **never** runs in the drift job — that is WP-Q02).

## Runners (`packages/server/src/test-harness/`)

| Suite                              | Runner                                                                  | When                                                      |
| ---------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| dry_run round-trip (authoritative) | `dry-run-roundtrip.contract.ts` + PHP `tests/test-dry-run-fixtures.php` | `pnpm test:contract` / `composer test:php` (needs wp-env) |
| pre-filter subset (§4)             | `prefilter-subset.test.ts`                                              | `pnpm test:unit` (no WP)                                  |
| round-trip identity (§7)           | `roundtrip-identity.contract.ts`                                        | `pnpm test:contract` (needs wp-env)                       |
| Inspector smoke (§8)               | `inspector-smoke.ts`                                                    | `pnpm test:smoke` (needs wp-env + built server)           |

The `*.contract.ts` / `inspector-smoke.ts` runners feature-detect the PHP validator / `page.dry_run`
tool and **skip with a clear message** when absent (the route is WP-P03, the tool is WP-T) — the
skeleton lands in Wave 1 and is flipped on by WP-P03/WP-T's DoD. The render assertion (S1, §3 step 3)
is present but **skipped with reason** until WP-S01 PASS.
