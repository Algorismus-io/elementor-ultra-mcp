# Round-trip identity fixtures (WP-Q05)

`kind:"roundtrip"` fixtures for the round-trip identity suite
(`spec/contracts/14-fixtures-harness.md §7`, RESEARCH §9.3e). Each carries
`{ input_tree, normalized_expected }`.

The suite proves **`build → read → normalize → equal`**: `page.build(input_tree)`
→ `page.get_structure` → `normalize()` BOTH trees (the shared normalizer in
`packages/server/src/authoring/contract.ts`) → assert **structural** equality.
This is the M2 safe-edit guarantee — a faithful round-trip shows **zero**
structural delta, so production edits never surface phantom changes
(`00-product-overview.md §6`).

## Normalizer tolerances (what does NOT count as a diff)

- **`_cssid` injection** — auto-injected into atomic `settings`
  (`has-atomic-base.php:310-321`); stripped on read (RESEARCH §4.1).
- **empty sibling keys** — `styles` / `editor_settings` / `interactions` /
  `elements` that are empty are dropped (so `{styles:{}}` == absent).
- **html-v3 normalization** — text presence compared; the inline-only `wp_kses`
  allowlist is applied by PHP, not re-run here (RESEARCH §6.6).
- **minted ids** — element ids AND **local-style ids** are re-minted on save
  (spike **C2 / R5**: local-style ids are NOT stable across save). The
  round-trip test compares ids **structurally / positionally**, NEVER literally:
  it builds an id-map (element ids + `styles` keys + `StyleDefinition.id` + the
  mirrored entry in `classes.value`) from the positional walk, then asserts
  equality under that mapping. The shared `normalize()` PRESERVES ids; the
  structural remap lives in the test (`roundtrip-identity.test.ts`).
- **global-class ids** (`g-*`) are stable external references — preserved
  verbatim (NOT remapped).

Run as **ADMIN** so the content-sanitizer `title` rewrite is exempt
(RESEARCH §2.1/§6.6, §7 step 3).

## Fixtures

| File                                     | Generation | Covers                                                                                  | `requires`                       | prefilter |
| ---------------------------------------- | ---------- | --------------------------------------------------------------------------------------- | -------------------------------- | --------- |
| `e-heading.basic.roundtrip.json`         | v4         | basic atomic widget (h2, html-v3 title, `_cssid` tolerated)                             | `e_atomic_elements`              | defer     |
| `hero-section.roundtrip.json`            | v4         | composite atomic subtree (`e-div-block` > `e-heading` + `e-paragraph`); nested id remap | `e_atomic_elements`              | defer     |
| `e-image.id-only.roundtrip.json`         | v4         | atomic image, **id-only** `image-src` (post-sideload preferred shape, R9 XOR)           | `e_atomic_elements`              | defer     |
| `styles.local-and-global.roundtrip.json` | v4         | local style (R4 mirrored) + global-class ref; **local-style id remap (R5)**             | `e_atomic_elements`, `e_classes` | defer     |
| `v3.container.roundtrip.json`            | v3         | V3 classic fallback (`container` > classic `heading`)                                   | —                                | defer     |

The seed bootstrap fixture `e-heading.identity.json` is owned by **WP-F06** (not
Q05) and exercises the same suite; Q05 adds only the five files above.

## Suite + tests

- `packages/server/src/test-harness/roundtrip-identity.test.ts` — the round-trip
  identity suite. The **offline** half (`normalize(input_tree)` equals
  `normalize(normalized_expected)`, plus the structural-id self-checks) runs in
  every lane (no WordPress). The **live** half (`build → get_structure →
normalize → equal`) feature-detects the `page.build` / `page.get_structure`
  routes (Pages vertical, WP-T) and SKIPS with a clear message until they land;
  disposable draft docs are created + trashed per test. Runs under
  `pnpm test:contract` (the wp-env stage).
- `packages/server/src/authoring/contract.normalize.test.ts` — unit tests for the
  WP-F03 `normalize()` (imported from `./contract.js`): idempotence,
  `_cssid` tolerance, empty-sibling-key tolerance, html-v3 normalization, and the
  structural-id comparison helper. Does NOT modify or re-implement `normalize()`.

## `requires` gates

Atomic fixtures gate on `e_atomic_elements`; the styles fixture additionally
gates on `e_classes`. The V3 fixture has no experiment gate. A fixture whose
`requires` are unmet on the target install is SKIPPED (not failed), so the same
corpus is green on free-only / atomic-off installs (`§2`).
