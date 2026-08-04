# 01 — System Architecture: ULTRA Elementor MCP

> Authority: this document defines the **principles, module boundaries, dependency model, parallelization strategy, repo layout, deployment topology, and cross-cutting ownership** that every work package (WP) author MUST follow. It does NOT enumerate work packages — the assembler builds the DAG later. It is grounded in and cites `RESEARCH.md` (architecture blueprint) and `SUPPLEMENT.md` (deep reference); every Elementor behavior cites `path:line` from `plugins/elementor` / `plugins/elementor-pro`.
>
> Locked decisions (from the mission brief, restated for self-containment):
> - **Hybrid** = companion WordPress plugin (PHP) at `plugin/elementor-ultra-mcp` **+** external TypeScript/Node MCP server at `packages/server` on `@modelcontextprotocol/sdk ^1.29` (NOT 2.x alpha; `inputSchema`/`outputSchema` are **ZodRawShape maps**).
> - Deployment: agency **LOCAL/DEV** sites, **single-site first, multisite-aware**.
> - New pages default to **V4 atomic**, fall back to **V3** when atomic inactive (probe capabilities first).
> - HTML conversion **NEVER auto-commits** (always dry-run + diff + coverage report + explicit `commit`, elicitation confirm).
> - WooCommerce **deferred to ULTRA** (context-validation contract specified now).
> - The **PHP `dry_run` is the AUTHORITATIVE validator**; the TS validator is a **pre-filter only**.
> - V4 atomic CSS does NOT render on a headless save → a **prime-css** step is MANDATORY (gated on spike WP-S01).
> - `UPDATE_CLASS` is migration-granted (admin-only) → the companion plugin **grants it idempotently on activation**.
> - Auth = WordPress **Application Passwords (HTTP Basic)**. Transport = **stdio + Streamable HTTP**.

---

## 1. The hybrid component model

The system is a **hybrid**: a *fat* external TypeScript MCP server plus a *focused* companion WordPress plugin, separated by an HTTP/Basic-auth seam, with Elementor + WordPress underneath. This reproduces `RESEARCH.md §3.1` (component diagram) and the §3.2 fork decision ("BLEND, REST-primary + Abilities-secondary").

### 1.1 Why hybrid (the load-bearing constraint)

The single missing primitive is **writing the element tree over a clean, authenticated, headless path** (`RESEARCH.md §1` bullet 3). Elementor's built-in MCP can read structure and set document *settings* but has **no element-tree write** (`update-settings-ability.php` only ever passes `['settings'=>…]`). The canonical write is `Document::save(['elements'=>…, 'settings'=>…])` (`core/base/document.php:795-893`), reachable cleanly only via admin-ajax `save_builder` (cookie+nonce) — which Application-Password/Basic auth does **not** reach (`RESEARCH.md §8`). Therefore a companion PHP plugin must expose `Document::save()` over an App-Password REST route. Everything else flows from that one fact:

- The PHP plugin must run **inside WordPress** to touch Elementor's internal PHP APIs (documents manager, repositories, `get_props_schema()`, `Conditions_Manager::save_conditions()`, atomic CSS priming) — these are not reachable over HTTP otherwise.
- Atomic saves **throw** on one bad prop (`has-atomic-base.php:88-117`), so the **validator must run PHP-side** where it can instantiate every node (`RESEARCH.md §1` bullet 5).
- Rich MCP ergonomics (tool catalog, HTML→native semantic mapping, diffing, idempotency, pagination) are far easier in TS and do not need WordPress — so they live in the **external server**.

### 1.2 The four tiers and each module's responsibility

```
┌─ TIER 1: MCP CLIENT ────────────────────────────────────────────────────────┐
│  Claude Desktop / Claude Code / Cursor / Angie / navigator.modelContext       │
└───────────────┬───────────────────────────────────────────────────────────────┘
                │  MCP protocol  (stdio | Streamable HTTP)
                ▼
┌─ TIER 2: ULTRA TS MCP SERVER  (packages/server, @mcp/sdk ^1.29) ──────────────┐
│  Owns: MCP protocol, tool/resource/prompt surface, HTML→native pipeline,       │
│  diff/dry-run orchestration, idempotency, ID minting+dedupe, PRE-FILTER        │
│  validation, per-site auth store, pagination, tool-profile management.         │
│  Owns NO database access. Talks ONLY to Tier 3 over HTTP/Basic.                 │
└───────────────┬───────────────────────────────────────────────────────────────┘
                │  HTTPS, Authorization: Basic base64(user:app-password)
                │  (the SEAM = frozen REST contract, spec/contracts/rest-api/)
                ▼
┌─ TIER 3: COMPANION WP PLUGIN  (plugin/elementor-ultra-mcp, PHP) ───────────────┐
│  Owns: custom REST /wp-json/elementor-ultra/v1/*, the AUTHORITATIVE validator,  │
│  Document::save() wrapping, txn edit (base_hash/locks/autosave), CSS priming,   │
│  revision-independent backups, ID validate/remap, design-system via repository, │
│  media sideload, nav, templates, Pro conditions, op log, capability probe,      │
│  idempotent UPDATE_CLASS grant on activation. SECONDARY: WP Abilities +         │
│  own create_server() when the MCP Adapter is present (graceful no-op otherwise).│
└───────────────┬───────────────────────────────────────────────────────────────┘
                │  in-process PHP calls
                ▼
┌─ TIER 4: ELEMENTOR + WORDPRESS ────────────────────────────────────────────────┐
│  documents / widgets_manager / elements_manager / kits_manager / files_manager  │
│  / db ; atomic-widgets, global-classes (via Global_Classes_Repository),         │
│  variables, design-system-sync ; Pro Conditions_Manager ; Document::save().     │
│  Data model: _elementor_data (JSON), _elementor_page_settings, e_global_class    │
│  CPT, kit meta _elementor_global_variables. (RESEARCH.md §2.1–2.2)              │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Module-level responsibilities (the canonical division of labor; cited to `RESEARCH.md §3.1` and §9.2):

| Module group | Tier | Responsibility | MUST NOT |
|---|---|---|---|
| Transport (`transport/stdio.ts`, `transport/http.ts`) | TS | Select & run stdio or `StreamableHTTPServerTransport`; manage stateful session Map for HTTP | Contain business logic |
| Server core (`server.ts`, `index.ts`) | TS | `McpServer` init, tool registry, lean/full profiles, `sendToolListChanged` | Touch WP directly |
| WP client (`wp/client.ts`, `wp/routes.ts`) | TS | The ONLY place that issues HTTP to Tier 3; Basic auth, retries, pagination, typed wrappers | Embed tool-shaped logic |
| Tools / resources / prompts (`tools/*`, `resources/*`, `prompts/*`) | TS | MCP surface; call `wp/routes.ts`; shape MCP I/O per frozen catalog | Build raw HTTP, embed validation truth |
| Authoring (`authoring/*`) | TS | Canonical node types, `$$type` envelopes, 7-hex ID mint+dedupe, CHEAP pre-filter | Be authoritative on validity |
| Convert pipeline (`convert/*`) | TS | HTML→native parse→…→assemble; orchestrate dry-run+commit | Persist without PHP dry_run + explicit commit |
| Safety (`safety/*`) | TS | Diff shaping, idempotency keys, cross-doc batch planning | Own the lock (PHP owns it) |
| REST controllers (`includes/rest/*`) | PHP | HTTP I/O, `permission_callback` (the security boundary), arg shaping | Hold core algorithms (delegate to `core/*`) |
| Core services (`includes/core/*`) | PHP | Txn writer, **authoritative validator**, CSS primer, ID service, backup, cache | Be reachable except through controllers/abilities |
| Abilities (`includes/abilities/*`) | PHP | Secondary WP-Abilities path; `create_server()` on `mcp_adapter_init` | Be a hard dependency of any feature |

---

## 2. The MODULE BOUNDARY MAP (every module + the exact seam between them)

A "seam" is the **only** sanctioned way two modules interact. Building against the seam — not the implementation — is what makes WPs independent. Each seam below names its **frozen contract artifact** under `spec/contracts/`.

### 2.1 Seam A — Client ⇄ TS server (MCP protocol)

- **Producers:** TS `tools/*`, `resources/*`, `prompts/*`.
- **Consumers:** any MCP client.
- **Interface:** the **MCP tool/resource/prompt catalog** — names, `inputSchema`/`outputSchema` (ZodRawShape maps in `@mcp/sdk ^1.29`), annotations (`readOnlyHint`/`idempotentHint`/`destructiveHint`), pagination shape `{limit,cursor,fields[]}` → `{items,next_cursor,total}` (`RESEARCH.md §5` conventions, §5.11).
- **Frozen contract:** `spec/contracts/mcp-catalog/` (WP-F04). Tool **names** and **I/O schemas** are immutable identifiers downstream WPs reuse verbatim.
- **Rule:** a tool WP may ship its own tool module so long as its tool names + schemas match the frozen catalog. Two tool WPs in the same wave must own **disjoint** `tools/*.ts` files (§4.3).

### 2.2 Seam B — TS server ⇄ companion plugin (the REST API)

This is the **central seam** and the one most WPs depend on. It is HTTP, Basic-auth, JSON.

- **Producer:** PHP `includes/rest/*` controllers at `/wp-json/elementor-ultra/v1/*`.
- **Consumer:** TS `wp/routes.ts` (the only TS module allowed to know these URLs/shapes).
- **Interface:** route paths, methods, request bodies, response bodies, error envelope. Cataloged in `RESEARCH.md §3.1` (route list) and §5 (per-tool Side=PHP/BOTH).
- **Frozen contract:** `spec/contracts/rest-api/openapi.yaml` + generated/shared types (WP-F02). Route **names** and **payload shapes** are immutable.
- **Rule:** the TS side codes against the OpenAPI types; the PHP side implements the same OpenAPI. **Neither reads the other's source.** A TS tool WP and the PHP controller WP that backs it can be built in parallel because both target the frozen REST contract, not each other.

Canonical routes the seam exposes (authority for `wp/routes.ts` and `includes/rest/*`; `RESEARCH.md §3.1`, §5):
`documents/{id}/save | edit | dry-run | prime-css | backup | rollback`; `schema/widget/{type} | styles | registered-types | breakpoints`; `design/classes (diff-PUT) | variables (watermark) | global-colors | global-fonts | sync | element-defaults | deploy`; `media/upload | sideload | list`; `nav/menus | bind-widget`; `templates/* | kit/*`; `pro/* (conditions via Conditions_Manager)`; `cache/regen`; `ids/validate | remap`; `lock-status`; `autosave-status`; `ops/log`; `site/capabilities`.

### 2.3 Seam C — companion plugin ⇄ Elementor/WP (PHP API)

- **Producer:** Elementor 4.1.1 + Pro 4.1.0 internal PHP APIs.
- **Consumer:** PHP `includes/core/*` (and only core, never controllers directly).
- **Interface:** Elementor's public/quasi-public PHP surface, cited by `path:line`. Load-bearing entry points:
  - Save: `Document::save($data)` — `core/base/document.php:795-893`. Filter `elementor/document/save/data` at `:817`; editable check `:821`; `wp_kses_post` map for non-`unfiltered_html` users `:841`; CSS delete `:867`; cache delete `:872`.
  - Read tree: `documents->get($id)->get_elements_data()` (autosave/draft merge `:1124-1152`); raw+normalized `get_elements_raw_data(null,true)`.
  - Atomic schema: `get_props_schema()` (post-filter, injects `_cssid`) — `has-atomic-base.php:310-321`. **Fetch this, not `define_props_schema()`.**
  - Atomic validation throw points: `parse_atomic_settings` / `parse_atomic_styles` — `has-atomic-base.php:88-117` (`:95-98` message; **catch the `\Exception`, do not string-match**).
  - Global classes: **always** via `Global_Classes_Repository` (migration-transparent; CPT `e_global_class`, `global-class-post-type.php:10`); REST PUT is **diff-based** `apply_changes()` (`global-classes-rest-api.php:165-224,306-390`), gated on `current_user_can(Add_Capabilities::UPDATE_CLASS)` `:154`.
  - Variables: kit meta `_elementor_global_variables`; all three types FREE (`variables/hooks.php:48-51`).
  - Pro conditions: `Conditions_Manager::save_conditions()` + `cache->regenerate()` — `conditions-manager.php:300-326` (slash-joined storage, NOT raw meta).
  - Atomic CSS: rendered ONLY on frontend hooks `atomic-styles-manager.php:47-150`; `Post_CSS::create($id)->update()` is the V3 path and **no-ops for atomic** → prime-css required (`RESEARCH.md §7.4`).
- **Frozen contract:** none new — this seam is constrained by Elementor itself. WPs cite `path:line`; the **authoring JSON contract** (WP-F03) is the *shape* this seam consumes/produces and `spec/contracts/elementor-apis.md` (WP-F02-adjacent) catalogs the entry points.
- **Rule:** never invent Elementor APIs. Never raw-write `_elementor_data` (unless `wp_slash(wp_json_encode())` **and** manual cache delete — prefer the pipeline; `RESEARCH.md §7.3`).

### 2.4 Seam D — the authoring JSON contract (the shared data shape that crosses A, B, and C)

The element-tree JSON is the one artifact that flows through **every** tier: a client asks for a page, the TS server emits the authoring JSON, the REST seam carries it, PHP validates+saves it. It therefore needs its own frozen contract independent of any route.

- **Frozen contract:** `spec/contracts/authoring/` (WP-F03) — V4 atomic node shape, V3 classic node shape, the `$$type` typed-envelope table, validation rules, ID rules. Authority: `RESEARCH.md §4`, `SUPPLEMENT.md §B`.
- **Realized as:** shared TS types (`packages/server/src/authoring/contract.ts` + `packages/shared`) AND JSON Schemas (`spec/contracts/schemas/`) used by golden-fixture tests on both sides.
- **Rule:** the TS authoring types and the JSON Schemas are generated from / validated against the same source. Both PHP fixtures and TS fixtures round-trip the same golden trees (WP-F06).

### 2.5 Seam E — error taxonomy & capability probe (cross-cutting seam)

- **Interface:** a single error taxonomy (`RESEARCH.md §7.5`): protocol errors → JSON-RPC `-32602` for arg/schema failures; business failures (missing atomic prop, invalid widgetType, lock held, autosave conflict, budget exceeded, `DUPLICATED_LABEL`) → result with `isError:true` + actionable text. PHP `WP_Error`/caught `\Exception` map to `isError` text (with structured parser errors), not protocol errors, when the agent can self-correct.
- **Capability probe:** `site/capabilities` returns `{v4,atomic,global_classes,variables,pro,pro_atomic_form,breakpoints[],experiments{},can_update_class,classes_migrated}` (`RESEARCH.md §5.1`). Every feature gates on this before assuming a route exists (experiment slugs `e_atomic_elements` BETA/default-inactive, `e_classes`, `e_variables`, `e_opt_in_v4_page`, `e_pro_atomic_form`, `e_wp_abilities_api` — `RESEARCH.md §8`).
- **Frozen contract:** `spec/contracts/errors/` + `spec/contracts/capabilities/` (WP-F05). Error **codes** and capability **field names** are immutable identifiers.

### 2.6 Boundary map summary table

| Seam | Between | Medium | Frozen contract (WP) | Immutable identifiers |
|---|---|---|---|---|
| A | Client ⇄ TS | MCP | `spec/contracts/mcp-catalog/` (F04) | tool/resource/prompt names + schemas |
| B | TS ⇄ PHP | HTTP/Basic | `spec/contracts/rest-api/openapi.yaml` (F02) | route paths, payload shapes |
| C | PHP ⇄ Elementor | PHP in-proc | `spec/contracts/elementor-apis.md` (cites Elementor) | Elementor `path:line` entry points |
| D | all tiers | JSON | `spec/contracts/authoring/` + `schemas/` (F03) | node shape, `$$type` table, ID rules |
| E | all tiers | data | `spec/contracts/errors/` + `capabilities/` (F05) | error codes, capability field names |

---

## 3. The dependency model between layers (and WHY it enables parallelism)

### 3.1 Two kinds of dependency

1. **Frozen-contract dependency (preferred).** WP X depends on a *document* under `spec/contracts/` (a route shape, a schema, an error code). The contract is **frozen** at the end of Wave 0 and does not change. X can be built the moment the contract exists, regardless of whether the *implementation* on the other side of the seam has been written. Example: a TS tool WP depends on `spec/contracts/rest-api/openapi.yaml`, not on the PHP controller that implements that route.

2. **Code dependency (minimized).** WP X depends on a *named upstream WP ID* whose code it links against or extends in the same file/module. Example: every WRITE WP depends on the **PHP `dry_run` validator WP** (a code dependency) because it must call it before commit; every atomic-CSS-affecting WP depends on the **prime-css WP** and **WP-S01**.

> The PARALLELISM PRINCIPLE: **prefer (1) over (2).** A WP may depend ONLY on (a) frozen contract docs under `spec/contracts/`, and (b) named upstream WP IDs. If two features would otherwise edit the same file, either merge them into one WP or split the file so ownership is disjoint (§4.3).

### 3.2 Why frozen contracts buy parallelism

Because Seam B (REST) and Seam D (authoring JSON) are frozen as **data shapes**, the TS implementation of a tool and the PHP implementation of its backing route never read each other's source — they both target the OpenAPI + JSON-Schema. So they are **schedulable in the same wave on different teams**. The only synchronization point is the contract freeze (end of Wave 0) and the integration test at the wave boundary (§4.4). Code dependencies are reserved for genuine "must call this function" relationships (validator, prime-css, ID service) and are kept few and explicit.

### 3.3 Mandatory dependency rules (enforced by the assembler)

- **Every WRITE work package** (anything that calls `Document::save()` or mutates kit/design state) MUST declare a dependency on the **PHP `dry_run` validator WP** — the PHP `dry_run` is the single source of truth for validity (`RESEARCH.md §1` bullet 5, §4.5).
- **Every atomic-CSS-affecting work package** (any WP that saves a V4 atomic tree or touches global classes/variables/kit) MUST depend on the **prime-css WP** AND **WP-S01** (headless atomic save + CSS priming) — atomic CSS does not render on a headless save (`RESEARCH.md §7.4`).
- **Foundation WP IDs every layer may depend on:** WP-F01 (scaffold), WP-F02 (REST contract types/openapi), WP-F03 (authoring contract + types + schemas), WP-F04 (MCP catalog schemas), WP-F05 (error taxonomy + capability probe), WP-F06 (golden-fixtures harness), WP-F07 (CI incl schema-drift). These are the shared substrate; depending on them does not constrain parallelism within a wave.
- **Spike outputs gate features:** WP-S01 (atomic save + CSS prime) gates all V4 save/prime WPs; WP-S02 (template-library atomic) gates atomic template WPs; WP-S03 (HTML coverage baseline) gates the convert coverage gate; WP-S04 (save_settings merge) gates `update_settings`; WP-S05 (UPDATE_CLASS) gates design-system writes; WP-S06 (App-Password over HTTP) gates the auth/dev-env WP; WP-S07 (flush-css `--network`) gates multisite cache.

### 3.4 The dependency direction is strictly downward across tiers

TS depends on the REST contract (downward to Seam B); PHP depends on the authoring contract + Elementor APIs (downward to Seams D/C). **Nothing upstream depends on something downstream's implementation.** A controller WP does not depend on the tool WP that will call it; it depends only on the frozen REST + authoring contracts. This keeps the DAG acyclic and the waves clean.

---

## 4. The PARALLELIZATION STRATEGY (the wave model)

### 4.1 Wave model

Waves are scheduling bands. A WP enters a wave when all its dependencies are satisfied by **prior** waves (or by frozen contracts). Within a wave, WPs run fully in parallel.

- **Wave 0 — Contracts + Scaffold + Spikes.** Establish the repo (WP-F01), **freeze all seam contracts** (WP-F02 REST, WP-F03 authoring, WP-F04 MCP catalog, WP-F05 errors/capabilities), stand up the fixture harness (WP-F06) and CI (WP-F07), and run the day-0 spikes (WP-S01..S07, `RESEARCH.md §0`). **Nothing downstream starts until Wave 0 freezes the contracts.** The spikes that gate the most WPs (S01 atomic save+prime, S03 HTML coverage) are highest priority. Output of Wave 0: an immutable `spec/contracts/` tree + spike findings recorded as decisions.

- **Wave 1 — Foundation services.** The shared runtime substrate that many verticals call but that itself depends only on frozen contracts + scaffold: the TS server core + transport + WP client (`server.ts`, `transport/*`, `wp/client.ts`); the PHP plugin bootstrap + activation grant + the **authoritative validator** + the **document writer (txn/base_hash/locks/autosave)** + the **CSS primer** + the **ID service** + the **backup service** + the **capability/site controller**. These are the most-depended-upon code dependencies (the validator and prime-css are mandatory upstreams per §3.3), so they ship before the verticals.

- **Wave 2+ — Independent verticals.** Once foundation services exist, each vertical is a near-self-contained slice that owns disjoint files and depends on frozen contracts + Wave-1 services: Pages/CRUD vertical, Widget/element ops vertical, Design-system vertical, Media vertical, Nav vertical, Templates/kits vertical, HTML→native pipeline vertical (the flagship), Pro surface vertical, Ops/observability vertical, and the QA/release vertical. Multiple verticals run concurrently; their phase (MVP/v1/ULTRA per `RESEARCH.md §9.1`) decides *when*, not *whether*, they can parallelize.

### 4.2 Phase ↔ wave relationship

`phase` (foundation/MVP/v1/ULTRA) is the **product milestone** (from `RESEARCH.md §9.1`); `wave` is the **build-scheduling band**. They correlate but are not identical: a vertical may have an MVP-phase WP in an early wave and a v1-phase WP in a later wave. Each WP carries `phase` in frontmatter so the roadmap can be reconstructed; the assembler computes the wave from `depends_on`.

### 4.3 The disjoint-files rule (the core invariant)

**Same-wave WPs MUST have disjoint `files_owned`.** The assembler PROVES two same-wave WPs never touch the same file by set-intersecting their `files_owned` lists. To satisfy this:

- Declare `files_owned` as **exact repo-relative paths** the WP creates or edits — never a directory glob that could overlap a sibling.
- If two features would edit the same file, **either merge them into one WP or split the file** so each WP owns a disjoint file. Example: rather than two WPs both editing `server.ts` to register tools, have each tool WP own its own `tools/<name>.ts` and have a single foundation WP own the registry wiring in `server.ts` (registration is data-driven so adding a tool file does not edit `server.ts`).
- Shared "spine" files (`server.ts`, `wp/routes.ts`, `includes/class-plugin.php`, the REST router registration) are owned by **exactly one foundation WP**; verticals extend behavior by adding their own files that the spine discovers, not by editing the spine. Where unavoidable, the spine file is owned by one WP and other WPs depend on it (code dependency), pushing them to a later wave.

### 4.4 Integration at wave boundaries

Integration is not a separate "integration phase" — it is a **gate at each wave boundary**, executed by the golden-fixture + contract-test harness (WP-F06) and CI (WP-F07):

1. **Contract conformance:** every PHP route is exercised against `spec/contracts/rest-api/openapi.yaml`; every TS tool against `spec/contracts/mcp-catalog/`. Mismatch fails CI.
2. **Schema-drift job:** fetch live `get_props_schema()` for every supported atomic widget and diff against the TS pre-filter's expectations; **fail on mismatch** (`RESEARCH.md §9.3b`) — catches Elementor version drift at the boundary, not in production.
3. **Golden-tree round-trip:** the same fixtures are validated by the TS pre-filter and the PHP `dry_run`; both must agree (PHP is authoritative; TS divergence that *under*-rejects is allowed, *over*-rejecting is a bug).
4. **Render assertion (S1 regression):** save atomic tree → prime-css → assert generated CSS contains the local + global class rules (`RESEARCH.md §9.3f`).

Because each seam has a frozen contract and a test that enforces it, a vertical that passes these gates is integration-ready without manual coordination with sibling verticals.

---

## 5. The canonical REPO LAYOUT (authority for all `files_owned` paths)

This is reproduced verbatim from `RESEARCH.md §9.2` and is the **single authority** for every `files_owned` path a WP declares. WP authors MUST use these exact paths; new files must slot into this tree.

```
elementor-ultra-mcp/
├─ packages/
│  ├─ server/                         # TS MCP server (npx-distributable)
│  │  ├─ src/
│  │  │  ├─ index.ts                  # bin entry; transport select (stdio/http)
│  │  │  ├─ server.ts                 # McpServer init, tool registry, profiles
│  │  │  ├─ transport/{stdio.ts,http.ts}
│  │  │  ├─ wp/
│  │  │  │  ├─ client.ts              # REST client (Basic auth, retries, pagination)
│  │  │  │  └─ routes.ts              # typed wrappers over elementor-ultra/v1/*
│  │  │  ├─ tools/
│  │  │  │  ├─ discovery.ts page.ts widget.ts design.ts media.ts nav.ts
│  │  │  │  ├─ templates.ts pro.ts convert.ts ops.ts meta.ts
│  │  │  ├─ resources/                # schema, design-system, page, templates
│  │  │  ├─ prompts/
│  │  │  ├─ authoring/
│  │  │  │  ├─ contract.ts            # canonical node types (V4 + V3)
│  │  │  │  ├─ envelopes.ts           # $$type wrappers
│  │  │  │  ├─ ids.ts                 # 7-hex mint + dedupe
│  │  │  │  └─ prefilter.ts           # CHEAP pre-validation (PHP is authoritative)
│  │  │  ├─ convert/
│  │  │  │  ├─ parse.ts normalize.ts classify.ts map.ts
│  │  │  │  ├─ style-extract.ts assemble.ts hoist.ts a11y.ts fidelity.ts
│  │  │  │  ├─ logical-props.ts       # direction-aware physical<->logical
│  │  │  │  └─ mapping-table.ts
│  │  │  └─ safety/{diff.ts,idempotency.ts,batch.ts}
│  │  ├─ package.json                 # @mcp/sdk ^1.29, zod peer; "bin"
│  │  └─ tsconfig.json
│  └─ shared/                         # JSON schemas + golden-tree fixtures (TS<->PHP)
├─ plugin/                            # companion WP plugin
│  └─ elementor-ultra-mcp/
│     ├─ elementor-ultra-mcp.php      # bootstrap, guards, activation (UPDATE_CLASS grant)
│     ├─ composer.json                # wordpress/mcp-adapter (jetpack autoloader)
│     ├─ includes/
│     │  ├─ class-plugin.php
│     │  ├─ rest/
│     │  │  ├─ class-documents-controller.php   # save/edit/dry-run/backup/rollback/prime-css
│     │  │  ├─ class-schema-controller.php       # widget(get_props_schema)/styles/types/breakpoints
│     │  │  ├─ class-design-controller.php       # classes(diff-PUT)/variables(watermark) via repository
│     │  │  ├─ class-media-controller.php        # sideload/upload/list
│     │  │  ├─ class-nav-controller.php          # menus
│     │  │  ├─ class-templates-controller.php
│     │  │  ├─ class-pro-controller.php          # conditions via Conditions_Manager
│     │  │  ├─ class-cache-controller.php
│     │  │  └─ class-ops-controller.php          # audit log
│     │  ├─ core/
│     │  │  ├─ class-document-writer.php         # txn save, base_hash, locks, autosave check
│     │  │  ├─ class-validator.php               # instantiate+validate dry-run (AUTHORITATIVE)
│     │  │  ├─ class-css-primer.php              # V4 atomic CSS priming (S1)
│     │  │  ├─ class-id-service.php              # mint/dedupe/remap
│     │  │  ├─ class-backup-service.php          # revision-independent snapshots
│     │  │  └─ class-cache-service.php
│     │  └─ abilities/                           # WP Abilities (secondary path)
│     │     ├─ class-abstract-ability.php class-ability-definition.php
│     │     ├─ class-save-elements-ability.php ...
│     │     └─ class-server-registrar.php        # create_server on mcp_adapter_init
│     └─ readme.txt
├─ tests/                             # see RESEARCH.md §9.3
├─ spec/                              # THIS spec tree (contracts + work-packages)
│  ├─ 01-architecture.md
│  ├─ contracts/
│  │  ├─ rest-api/openapi.yaml        # Seam B (WP-F02)
│  │  ├─ authoring/                   # Seam D (WP-F03)
│  │  ├─ mcp-catalog/                 # Seam A (WP-F04)
│  │  ├─ errors/                      # Seam E (WP-F05)
│  │  ├─ capabilities/                # Seam E (WP-F05)
│  │  ├─ elementor-apis.md            # Seam C reference (cites Elementor)
│  │  └─ schemas/                     # JSON Schemas (TS<->PHP golden fixtures)
│  └─ work-packages/                  # <ID>-<slug>.md per WP
└─ .wp-env.json                       # Elementor + Pro + plugin for CI/agent sites
```

> The `spec/` subtree above is the addition this architecture makes explicit; everything else is `RESEARCH.md §9.2` verbatim. WP authors: if a path you need is not in this tree, you are probably about to invent an overlap — re-check §4.3 before adding it, and prefer adding a *new disjoint file* under an existing directory over editing a spine file.

---

## 6. Runtime / deployment topology

### 6.1 Transports (`RESEARCH.md §3.2`, §8)

- **stdio** — local dev / Claude Desktop. Distributed via `npx @youragency/elementor-ultra-mcp` (a `bin` + shebang). Config carries `WP_URL`, `WP_USER`, `WP_APP_PASSWORD`, `ULTRA_TOOLS=lean|full`.
- **Streamable HTTP** — `StreamableHTTPServerTransport`. Stateful Map of sessions for editor-style use; `sessionIdGenerator: undefined` for stateless/serverless. Client config carries the MCP endpoint URL + `Authorization: Basic <base64(user:app-password)>`.
- Pin `@modelcontextprotocol/sdk ^1.29` — **NOT** `@modelcontextprotocol/server@2.0.0-alpha` (different API). In 1.x, `inputSchema`/`outputSchema` are **ZodRawShape maps** `{field: z.zodType}`, transports are deep `.js` imports, `zod` is a required peer.

### 6.2 Per-site auth map (`RESEARCH.md §8`)

The TS server holds a config map `site URL → {url, basicToken, capabilities}`. Every outbound call to Tier 3 sends `Authorization: Basic base64(user:app-password)` to both `wp/v2/*` and `elementor-ultra/v1/*`. Basic auth reaches all custom routes and design-system routes (they use `current_user_can(...)`, no nonce); it does **not** reach admin-ajax `save_builder` — which is precisely why the companion `documents/{id}/save` route exists. Per-site setup: install/activate plugin (runs idempotent `UPDATE_CLASS` grant) → create dedicated admin user with `unfiltered_html` → generate Application Password → verify via `site/capabilities` that `can_update_class=true`, atomic experiment active, `classes_migrated=true`.

### 6.3 Single-site first, multisite fan-out (`RESEARCH.md §8`)

- **Single-site** is the primary, default deployment. Everything works against one `{url, basicToken}`.
- **Multisite-aware:** ship as a network mu-plugin (one codebase); per-site Application Passwords. One TS server **fans out** to many sites via the config map. Bootstrap agency sites via a LocalWP Blueprint / `.wp-env.json` with Elementor + Pro + a base kit. Multisite cache flush uses `wp elementor flush-css --network` (reliability gated on WP-S07). Portable reuse via `page.export_template` (library-format JSON).
- **Local/dev caveat (WP-S06):** App Passwords normally require HTTPS but WP permits them on `is_local` environments (LocalWP/wp-env); if `wp_is_application_passwords_available()` returns false over plain HTTP, set the local-environment filter. Production needs HTTPS.

### 6.4 Built-in MCP coexistence

Elementor's own built-in Abilities MCP (`/wp-json/elementor/mcp`, 5 read abilities, gated + experiment-off by default — `RESEARCH.md §2.3`) runs **alongside** ours and is never a dependency. Our SECONDARY path registers our own abilities + our own `create_server()` at `/wp-json/elementor-ultra/mcp` on `mcp_adapter_init` **only when** the (external, not-bundled) WP Abilities API + MCP Adapter are present — graceful no-op otherwise (`RESEARCH.md §3.2`). The PRIMARY path is always the custom REST seam (Seam B).

---

## 7. Cross-cutting concerns map (which layer OWNS each)

Cross-cutting concerns are owned by exactly one layer to keep responsibilities disjoint. "Owns" = the authoritative implementation; "participates" = forwards/observes but is not the source of truth.

| Concern | OWNER (authoritative) | Participants | Authority |
|---|---|---|---|
| **AuthN/AuthZ** | **PHP** — REST `permission_callback` is the security boundary; `current_user_can(...)` per route | TS forwards `Authorization: Basic`; never makes trust decisions | `RESEARCH.md §8`; `global-classes-rest-api.php:154` (`UPDATE_CLASS`) |
| **Capability/experiment gating** | **PHP** — `site/capabilities` is the truth | TS probes it before assuming routes exist | `RESEARCH.md §8`; Seam E (WP-F05) |
| **`UPDATE_CLASS` grant** | **PHP** — idempotent `add_cap` on activation (to `administrator` + agent role) | — | `RESEARCH.md §8`; `add-capabilities.php:14,24` |
| **Validation (authoritative)** | **PHP `dry_run`** — instantiate + `get_data_for_save()` in try/catch | TS `prefilter.ts` is a cheap pre-filter ONLY | `RESEARCH.md §1` bullet 5, §4.5; `has-atomic-base.php:88-117` |
| **ID minting** | **TS** `authoring/ids.ts` (7-hex `dechex` style) | PHP `ids/validate`+`ids/remap` dedupe against live set + rewrite local-style back-refs | `RESEARCH.md §4.6`; `includes/utils.php:373-375` |
| **Idempotency** | **TS** `safety/idempotency.ts` mints `op_id`; combined with `base_hash` | PHP stores `op_id` (in `editor_settings`/hidden setting) + op log; detects+no-ops on replay | `RESEARCH.md §7` (Idempotency) |
| **Concurrency / locking** | **PHP** — `wp_check_post_lock()` + `get_newer_autosave()` before write; optimistic `base_hash = md5(_elementor_data)` | TS surfaces conflict to the agent | `RESEARCH.md §7`; `document.php:556-602` |
| **Undo / backup** | **PHP** — revision-independent `_emcp_backup_{ts}` meta + `wp_save_post_revision` (WP-P06 `backup`/`backups`/`rollback` routes) | TS exposes the custom `document.backup`/`document.rollback` flow (WP-T05) | `RESEARCH.md §7`; `revisions-manager.php:219-240` |
| **CSS regeneration / priming** | **PHP** `css-primer.php` (V4 prime via loopback render) + `cache-service.php` (V3/global flush) | TS triggers prime as a pipeline step | `RESEARCH.md §7.1–7.4`; `atomic-styles-manager.php:47-150` |
| **Diff / dry-run orchestration** | **PHP** produces the authoritative diff in `dry_run`; **TS** shapes/presents it (`safety/diff.ts`) | — | `RESEARCH.md §7`, §5.2 |
| **HTML→native semantic mapping** | **TS** `convert/*` | PHP only validates (dry_run) + persists + sideloads media | `RESEARCH.md §6` |
| **Observability / audit** | **PHP** `ops-controller.php` writes structured op log `(op_id,post_id,user,tool,before/after hash,result,ts)`; Abilities `create_server()` observability handler wired to it | TS threads `op_id` end-to-end; surfaces `ops.log` | `RESEARCH.md §5.10`, §5.24 |
| **Tool-surface management** | **TS** — namespacing, lean/full profiles, `tools.search`, `sendToolListChanged`, pagination | — | `RESEARCH.md §5.11` |
| **Error taxonomy** | **shared contract (WP-F05)**; PHP maps `WP_Error`/`\Exception` → `isError`; TS maps arg failures → `-32602` | both implement the same codes | `RESEARCH.md §7.5`; Seam E |
| **Destructive-op gating** | **TS** — `destructiveHint` + `elicitation/create` confirm (flat primitives only) | PHP enforces with `force` flag semantics | `RESEARCH.md §7.5` |

The guiding rule: **security, validity, persistence, locking, and CSS rendering are PHP's because they require WordPress/Elementor context; protocol, semantics, ID generation, idempotency keys, and presentation are TS's because they are protocol/algorithmic.** When in doubt, the layer that can be *wrong in a way that corrupts the site* owns the authoritative path.

### 7.1 Scope decision — undo surface: custom backup/rollback only (native WP revisions deferred)

RESEARCH §7 suggested exposing WP-native `revisions.list`/`revisions.restore` MCP tools. **Decision (this spec): the undo/safety surface is the custom, revision-INDEPENDENT backup/rollback path only** — `POST /documents/{id}/backup`, `GET /documents/{id}/backups`, `POST /documents/{id}/rollback` (WP-P06) surfaced as the `document.backup`/`document.rollback` tools (WP-T05). Native WordPress post revisions (`wp_get_post_revisions`/`wp_restore_post_revision`) are **intentionally NOT exposed** in MVP/v1/ULTRA, because: (a) the custom backup meta (`_emcp_backup_{ts}`) is more reliable for Elementor docs than core revisions (which can be disabled via `WP_POST_REVISIONS` and do not always capture `_elementor_data` cleanly), and (b) restoring a native revision would still require the same CSS-prime step, duplicating the rollback path. If native-revision exposure is later required, it is a future scoped WP that adds `GET /documents/{id}/revisions` + `POST /documents/{id}/revisions/{rev}/restore` (wrapping `wp_restore_post_revision` + `Css_Primer` prime) on the WP-P06 controller and corresponding `elementor.revisions.*` tools in WP-T05 + catalog schemas in WP-F04 — it is NOT part of the current contract, so the contract (no `revisions.*` route/tool) and the code agree.

---

## 8. Principles WP authors MUST follow (checklist)

1. Build against **frozen contracts** (`spec/contracts/`), not against another layer's source. Cite the contract section in `contract_refs`.
2. Declare **exact** `files_owned` paths from §5; never a glob that could overlap a sibling. Same-wave WPs must be provably disjoint (§4.3).
3. Every **WRITE** WP `depends_on` the PHP `dry_run` validator WP (§3.3).
4. Every **atomic-CSS-affecting** WP `depends_on` the prime-css WP **and** WP-S01 (§3.3).
5. Gate features on `site/capabilities`; never assume an experiment/route exists (§2.5, §7).
6. Never invent Elementor APIs; cite `path:line` for every Elementor behavior (Seam C). Never raw-write `_elementor_data` (`RESEARCH.md §7.3`).
7. PHP owns security/validity/persistence/locking/CSS; TS owns protocol/semantics/IDs/idempotency/presentation (§7). Do not duplicate the authoritative path on the other side.
8. HTML conversion never auto-commits — dry-run + diff + coverage report + explicit `commit` + elicitation confirm (§7 table; `RESEARCH.md §6.8`).
9. Pin `@modelcontextprotocol/sdk ^1.29`; schemas are ZodRawShape maps (§6.1).
10. Pagination on every read tool: `{limit,cursor,fields[]}` → `{items,next_cursor,total}` (`RESEARCH.md §5`); do NOT reuse `list-pages`' `posts_per_page=-1`.
