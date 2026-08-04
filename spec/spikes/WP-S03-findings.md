# WP-S03 — HTML→native coverage baseline (FINDINGS / the S3 number)

> **Canonical findings doc:** the full S03 write-up lives in
> [`S03-html-native-coverage-baseline.md`](./S03-html-native-coverage-baseline.md)
> (the name the WP-S03 ticket's `files_owned` mandates). This file is the
> convention-named (`WP-S0*-findings.md`) pointer/summary that mirrors the
> sibling spike findings; the two are kept in sync. The gate row also lives in
> [`SUMMARY.md`](./SUMMARY.md) §1.

## VERDICT: PASS (CORRECTS the hardcoded 85%)

On ≥5 real marketing sections, the parse→classify→map→style-extract loop achieves an
HONEST, reproducible native-prop coverage of:

| Band | Per-section native % | Corpus (declaration-weighted) |
|---|---|---|
| **REALISTIC** (the number that anchors the gate) | **76.8% – 90.5%** | **84.8%** native, 15.2% custom_css, 0.0% dropped |
| OPTIMISTIC (perfect typed-decompose; upper bound) | 83.2% – 94.0% | 89.5% native, 10.5% custom_css, 0.0% dropped |

- **The coverage number:** corpus REALISTIC = **84.8% native** (declaration-weighted),
  per-section REALISTIC band **76.8% – 90.5%**. The committed honest band is **~60–85%**
  (clean fixtures sit at the top; messy exported HTML lands ~60–75%).
- **Auto-commit floor = 60% native** (realistic band), read from `corpus.manifest.json`
  — never the literal 85%. Review band 60–70%; auto-commit-eligible ≥70% IFF visual-diff
  passes and no a11y blocker.
- Produced trees pass `dry_run` (`valid:true`). The converter never emits a tree PHP rejects.
- Per-property tail: `transition`/`transform`/`gradient`/`filter`/`text-clip`/`list-style`
  are 100% of the fallback tail; off-enum `font-weight`/`align-items`/`display:table` FALL;
  `grid repeat()/auto-fit-minmax` + correctly-decomposed `box-shadow`/`transform`/`filter`
  STICK (empirically confirmed via `Style_Parser::parse()`).

See the canonical doc for the full method (§2), per-section table (§3), per-property
fallback findings + the authoritative save-validation probe (§4), tree dry-run validity
(§5), `corpus.manifest.json` thresholds (§6), auto-commit policy (§7), caveats (§8), and
spike-gate impact (§9).
