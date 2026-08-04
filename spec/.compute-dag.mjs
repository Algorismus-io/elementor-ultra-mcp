// Compute build orchestration DAG from the WP manifest.
import { writeFileSync } from 'node:fs';

const manifest = [
  {"id":"WP-P01","title":"Companion plugin bootstrap, activation, autoloader & capability/experiment guards","layer":"php","phase":"foundation","depends_on":["WP-F05"],"files_owned":["plugin/elementor-ultra-mcp/elementor-ultra-mcp.php","plugin/elementor-ultra-mcp/composer.json","plugin/elementor-ultra-mcp/readme.txt","plugin/elementor-ultra-mcp/phpcs.xml.dist","plugin/elementor-ultra-mcp/includes/class-plugin.php","plugin/elementor-ultra-mcp/includes/core/class-activator.php","plugin/elementor-ultra-mcp/includes/core/class-guards.php"],"estimate":"M"},
  {"id":"WP-P02","title":"REST routing base, Application-Password auth, permission callbacks & WP_Error to envelope mapping","layer":"php","phase":"foundation","depends_on":["WP-P01","WP-F05"],"files_owned":["plugin/elementor-ultra-mcp/includes/rest/class-rest-registrar.php","plugin/elementor-ultra-mcp/includes/rest/class-abstract-controller.php","plugin/elementor-ultra-mcp/includes/rest/class-response.php","plugin/elementor-ultra-mcp/includes/rest/class-permissions.php","plugin/elementor-ultra-mcp/includes/rest/trait-pagination.php","plugin/elementor-ultra-mcp/includes/core/class-error.php"],"estimate":"M"},
  {"id":"WP-P03","title":"Validator core — the AUTHORITATIVE dry_run element-tree validator","layer":"php","phase":"MVP","depends_on":["WP-P01","WP-P02","WP-F03","WP-F05"],"files_owned":["plugin/elementor-ultra-mcp/includes/core/class-validator.php","plugin/elementor-ultra-mcp/includes/core/class-diff-builder.php"],"estimate":"L"},
  {"id":"WP-P04","title":"Core write services — Document_Writer (transactional save), Id_Service, Backup_Service","layer":"php","phase":"MVP","depends_on":["WP-P01","WP-P02","WP-P03"],"files_owned":["plugin/elementor-ultra-mcp/includes/core/class-document-writer.php","plugin/elementor-ultra-mcp/includes/core/class-id-service.php","plugin/elementor-ultra-mcp/includes/core/class-backup-service.php"],"estimate":"L"},
  {"id":"WP-P05","title":"CSS_Primer (V4 atomic CSS priming) + Cache_Service (V3 Post_CSS + full flush)","layer":"php","phase":"MVP","depends_on":["WP-P01","WP-P02","WP-S01"],"files_owned":["plugin/elementor-ultra-mcp/includes/core/class-css-primer.php","plugin/elementor-ultra-mcp/includes/core/class-cache-service.php"],"estimate":"M"},
  {"id":"WP-P06","title":"Documents REST controller (CRUD, dry-run, save, replace-tree, granular elements, prime-css, backup/rollback, duplicate, export, lock-status)","layer":"php","phase":"MVP","depends_on":["WP-P02","WP-P03","WP-P04","WP-P05","WP-S01"],"files_owned":["plugin/elementor-ultra-mcp/includes/rest/class-documents-controller.php"],"estimate":"L"},
  {"id":"WP-P07","title":"Schema + Site controller (widget/styles/registered-types/breakpoints + site/capabilities probe)","layer":"php","phase":"MVP","depends_on":["WP-P01","WP-P02"],"files_owned":["plugin/elementor-ultra-mcp/includes/rest/class-schema-controller.php"],"estimate":"M"},
  {"id":"WP-P08","title":"Design controller — global classes (diff-PUT upsert/delete/reorder, usage)","layer":"php","phase":"v1","depends_on":["WP-P02","WP-P03","WP-P05","WP-S05"],"files_owned":["plugin/elementor-ultra-mcp/includes/rest/class-design-classes-controller.php","plugin/elementor-ultra-mcp/includes/core/class-global-classes-service.php"],"estimate":"M"},
  {"id":"WP-P09","title":"Design controller — variables (watermark), V3 global colors/fonts, element-defaults, sync-v4-to-v3, deploy","layer":"php","phase":"v1","depends_on":["WP-P02","WP-P03","WP-P05","WP-P08","WP-S05"],"files_owned":["plugin/elementor-ultra-mcp/includes/rest/class-design-variables-controller.php","plugin/elementor-ultra-mcp/includes/core/class-variables-service.php"],"estimate":"L"},
  {"id":"WP-P10","title":"Media REST controller (list/search, sideload external URL with dedupe, raw/base64 upload)","layer":"php","phase":"MVP","depends_on":["WP-P02"],"files_owned":["plugin/elementor-ultra-mcp/includes/rest/class-media-controller.php"],"estimate":"M"},
  {"id":"WP-P11","title":"Nav/Menus REST controller (list, create+populate, bind Pro nav widget to a menu term)","layer":"php","phase":"v1","depends_on":["WP-P02","WP-P03","WP-P04"],"files_owned":["plugin/elementor-ultra-mcp/includes/rest/class-nav-controller.php"],"estimate":"S"},
  {"id":"WP-P12","title":"Templates & Kits REST controller (library list/get/save, import, insert-into-page, kit export/import/revert)","layer":"php","phase":"v1","depends_on":["WP-P02","WP-P03","WP-P04","WP-P05","WP-P10","WP-S01","WP-S02"],"files_owned":["plugin/elementor-ultra-mcp/includes/rest/class-templates-controller.php"],"estimate":"L"},
  {"id":"WP-P13","title":"Cache & IDs REST controller (cache regen/flush, ids validate/remap)","layer":"php","phase":"MVP","depends_on":["WP-P02","WP-P04","WP-P05","WP-S07"],"files_owned":["plugin/elementor-ultra-mcp/includes/rest/class-cache-controller.php"],"estimate":"S"},
  {"id":"WP-P14","title":"Ops audit-log store + controller (one row per WRITE route; GET /ops/log)","layer":"php","phase":"v1","depends_on":["WP-P01","WP-P02"],"files_owned":["plugin/elementor-ultra-mcp/includes/rest/class-ops-controller.php","plugin/elementor-ultra-mcp/includes/core/class-op-log.php"],"estimate":"S"},
  {"id":"WP-P15","title":"Cross-document batch handler (POST /batch/plan, POST /batch/apply with compensation)","layer":"php","phase":"ULTRA","depends_on":["WP-P02","WP-P03","WP-P04","WP-P05","WP-S01"],"files_owned":["plugin/elementor-ultra-mcp/includes/rest/class-batch-controller.php","plugin/elementor-ultra-mcp/includes/core/class-batch-runner.php"],"estimate":"M"},
  {"id":"WP-P16","title":"WP Abilities API secondary path — abilities + own create_server() via mcp-adapter (graceful no-op when absent)","layer":"php","phase":"ULTRA","depends_on":["WP-P01","WP-P03","WP-P04","WP-P05","WP-P07","WP-S01"],"files_owned":["plugin/elementor-ultra-mcp/includes/abilities/class-abstract-ability.php","plugin/elementor-ultra-mcp/includes/abilities/class-ability-definition.php","plugin/elementor-ultra-mcp/includes/abilities/class-save-elements-ability.php","plugin/elementor-ultra-mcp/includes/abilities/class-read-structure-ability.php","plugin/elementor-ultra-mcp/includes/abilities/class-dry-run-ability.php","plugin/elementor-ultra-mcp/includes/abilities/class-capabilities-ability.php","plugin/elementor-ultra-mcp/includes/abilities/class-server-registrar.php"],"estimate":"M"},
  {"id":"WP-T01","title":"TS server core runtime — McpServer init, registry wiring, profiles, surface mgmt, tool context","layer":"ts","phase":"MVP","depends_on":["WP-F01","WP-F02","WP-F04","WP-F05"],"files_owned":["packages/server/src/server.ts","packages/server/src/runtime/context.ts","packages/server/src/runtime/surface.ts","packages/server/src/runtime/capabilities-cache.ts","packages/server/src/runtime/elicit.ts","packages/server/src/runtime/index.ts","packages/server/src/runtime/surface.test.ts","packages/server/src/runtime/capabilities-cache.test.ts","packages/server/src/runtime/server-wiring.test.ts"],"estimate":"M"},
  {"id":"WP-T02","title":"TS transport layer — stdio + Streamable HTTP transport selection","layer":"ts","phase":"MVP","depends_on":["WP-F01"],"files_owned":["packages/server/src/transport/stdio.ts","packages/server/src/transport/http.ts","packages/server/src/transport/select.ts","packages/server/src/transport/http.test.ts"],"estimate":"M"},
  {"id":"WP-T03","title":"TS safety utilities — diff shaping, idempotency/op_id, batch plan/apply engine","layer":"ts","phase":"MVP","depends_on":["WP-F01","WP-F02","WP-F03","WP-P03"],"files_owned":["packages/server/src/safety/diff.ts","packages/server/src/safety/idempotency.ts","packages/server/src/safety/batch.ts","packages/server/src/safety/diff.test.ts","packages/server/src/safety/idempotency.test.ts","packages/server/src/safety/batch.test.ts"],"estimate":"M"},
  {"id":"WP-T04","title":"TS tool handlers — discovery / read (search, pages.list, get_structure, schema.*, breakpoints, dynamic)","layer":"ts","phase":"MVP","depends_on":["WP-F01","WP-F02","WP-F04","WP-F05","WP-T01"],"files_owned":["packages/server/src/tools/discovery.ts","packages/server/src/tools/discovery.test.ts"],"estimate":"M"},
  {"id":"WP-T05","title":"TS tool handlers — page CRUD (create, build, replace_tree, update_settings, dry_run, duplicate, delete, export)","layer":"ts","phase":"MVP","depends_on":["WP-F01","WP-F02","WP-F03","WP-F04","WP-T01","WP-T03","WP-P03","WP-P05","WP-S01"],"files_owned":["packages/server/src/tools/page.ts","packages/server/src/tools/page.test.ts"],"estimate":"L"},
  {"id":"WP-T06","title":"TS tool handlers — widget / element ops (get, insert, update_settings, move, delete, set_classes, set_local_style, bind_dynamic, bind_global)","layer":"ts","phase":"MVP","depends_on":["WP-F01","WP-F02","WP-F03","WP-F04","WP-T01","WP-T03","WP-P03","WP-P05","WP-S01"],"files_owned":["packages/server/src/tools/widget.ts","packages/server/src/tools/widget.test.ts"],"estimate":"L"},
  {"id":"WP-T07","title":"TS tool handlers — design system (classes diff-PUT, variables, global colors/fonts, defaults, sync, deploy)","layer":"ts","phase":"v1","depends_on":["WP-F01","WP-F02","WP-F03","WP-F04","WP-F05","WP-T01","WP-T03","WP-P03","WP-P05","WP-P08","WP-P09","WP-S01","WP-S05"],"files_owned":["packages/server/src/tools/design.ts","packages/server/src/tools/design-classes-diff.ts","packages/server/src/tools/design.test.ts","packages/server/src/tools/design-classes-diff.test.ts"],"estimate":"L"},
  {"id":"WP-T08","title":"TS tool handlers — media (sideload_url, upload, list)","layer":"ts","phase":"v1","depends_on":["WP-F01","WP-F02","WP-F04","WP-F05","WP-T01","WP-P10"],"files_owned":["packages/server/src/tools/media.ts","packages/server/src/tools/media.test.ts"],"estimate":"S"},
  {"id":"WP-T09","title":"TS tool handlers — navigation / menus (menus.list, menus.create, bind_widget)","layer":"ts","phase":"v1","depends_on":["WP-F01","WP-F02","WP-F04","WP-F05","WP-T01","WP-T03","WP-P03","WP-P11"],"files_owned":["packages/server/src/tools/nav.ts","packages/server/src/tools/nav.test.ts"],"estimate":"S"},
  {"id":"WP-T10","title":"TS tool handlers — templates / kits (list, get, save, import, insert_into_page, kit export/import/revert)","layer":"ts","phase":"v1","depends_on":["WP-F01","WP-F02","WP-F03","WP-F04","WP-F05","WP-T01","WP-T03","WP-P03","WP-P05","WP-P12","WP-P13","WP-S01","WP-S02"],"files_owned":["packages/server/src/tools/templates.ts","packages/server/src/tools/templates.test.ts"],"estimate":"M"},
  {"id":"WP-T11","title":"TS tool handlers — ops/observability + batch + meta-trio","layer":"ts","phase":"ULTRA","depends_on":["WP-F01","WP-F02","WP-F04","WP-F05","WP-T01","WP-T03","WP-P03","WP-P14"],"files_owned":["packages/server/src/tools/ops.ts","packages/server/src/tools/meta.ts","packages/server/src/tools/ops.test.ts","packages/server/src/tools/meta.test.ts"],"estimate":"M"},
  {"id":"WP-T12","title":"TS resource handlers — elementor:// read-only resource read/list callbacks","layer":"ts","phase":"v1","depends_on":["WP-F01","WP-F02","WP-F04","WP-F05","WP-T01"],"files_owned":["packages/server/src/resources/index.ts","packages/server/src/resources/handlers.ts","packages/server/src/resources/index.test.ts"],"estimate":"S"},
  {"id":"WP-T13","title":"TS prompt handlers — build-from-brief, html-to-native, design-system-audit (non-pro)","layer":"ts","phase":"v1","depends_on":["WP-F01","WP-F04","WP-T01"],"files_owned":["packages/server/src/prompts/build-from-brief.ts","packages/server/src/prompts/html-to-native.ts","packages/server/src/prompts/design-system-audit.ts","packages/server/src/prompts/index.ts","packages/server/src/prompts/prompts.test.ts"],"estimate":"S"},
  {"id":"WP-H01","title":"HTML-to-native role and prop mapping-table reference module","layer":"html","phase":"v1","depends_on":["WP-F03","WP-F04"],"files_owned":["packages/server/src/convert/mapping-table.ts","packages/server/src/convert/mapping-table.test.ts","packages/server/src/convert/types.ts"],"estimate":"M"},
  {"id":"WP-H02","title":"Direction-aware physical-to-logical CSS property reference module","layer":"html","phase":"v1","depends_on":["WP-F03","WP-H01"],"files_owned":["packages/server/src/convert/logical-props.ts","packages/server/src/convert/logical-props.test.ts"],"estimate":"M"},
  {"id":"WP-H03","title":"PARSE stage - render-then-extract via headless Playwright getComputedStyle","layer":"html","phase":"v1","depends_on":["WP-F03","WP-H01","WP-S03"],"files_owned":["packages/server/src/convert/parse.ts","packages/server/src/convert/parse.test.ts","packages/server/src/convert/browser-pool.ts","packages/server/src/convert/browser-pool.test.ts"],"estimate":"L"},
  {"id":"WP-H04","title":"NORMALIZE stage - block-child promotion, whitespace, URL resolution","layer":"html","phase":"v1","depends_on":["WP-F03","WP-H01","WP-H03"],"files_owned":["packages/server/src/convert/normalize.ts","packages/server/src/convert/normalize.test.ts"],"estimate":"M"},
  {"id":"WP-H05","title":"CLASSIFY stage - semantic role assignment (deterministic + AI-IR seam)","layer":"html","phase":"v1","depends_on":["WP-F03","WP-H01","WP-H03","WP-H04"],"files_owned":["packages/server/src/convert/classify.ts","packages/server/src/convert/classify.test.ts","packages/server/src/convert/flex-inference.ts","packages/server/src/convert/flex-inference.test.ts"],"estimate":"L"},
  {"id":"WP-H06","title":"MAP stage - role-to-atomic-element-type compilation + generation/tag selection","layer":"html","phase":"v1","depends_on":["WP-F03","WP-H01","WP-H05"],"files_owned":["packages/server/src/convert/map.ts","packages/server/src/convert/map.test.ts"],"estimate":"M"},
  {"id":"WP-H07","title":"STYLE-EXTRACT stage - Style-Schema-valid style variants + fallback ladder","layer":"html","phase":"v1","depends_on":["WP-F03","WP-F05","WP-P02","WP-P03","WP-P05","WP-H01","WP-H02","WP-H06","WP-S01"],"files_owned":["packages/server/src/convert/style-extract.ts","packages/server/src/convert/style-extract.test.ts","packages/server/src/convert/declaration-classifier.ts","packages/server/src/convert/declaration-classifier.test.ts"],"estimate":"L"},
  {"id":"WP-H08","title":"ASSEMBLE stage - build atomic tree, mint IDs, sideload media, wrap envelopes","layer":"html","phase":"v1","depends_on":["WP-F03","WP-F05","WP-P02","WP-P03","WP-P05","WP-P06","WP-H01","WP-H06","WP-H07","WP-S01"],"files_owned":["packages/server/src/convert/assemble.ts","packages/server/src/convert/assemble.test.ts"],"estimate":"L"},
  {"id":"WP-H09","title":"HOIST/dedup global classes + literal-to-variable extraction","layer":"html","phase":"v1","depends_on":["WP-F03","WP-F05","WP-P02","WP-P03","WP-P05","WP-H01","WP-H07","WP-H08","WP-S01"],"files_owned":["packages/server/src/convert/hoist.ts","packages/server/src/convert/hoist.test.ts","packages/server/src/convert/variable-extract.ts","packages/server/src/convert/variable-extract.test.ts"],"estimate":"L"},
  {"id":"WP-H10","title":"A11Y lint + FIDELITY visual-diff + CoverageReport assembly + commit gate","layer":"html","phase":"ULTRA","depends_on":["WP-F03","WP-F05","WP-F06","WP-P02","WP-P03","WP-P05","WP-H01","WP-H03","WP-H04","WP-H07","WP-H08","WP-H09","WP-S01","WP-S03"],"files_owned":["packages/server/src/convert/a11y.ts","packages/server/src/convert/a11y.test.ts","packages/server/src/convert/fidelity.ts","packages/server/src/convert/fidelity.test.ts","packages/server/src/convert/coverage.ts","packages/server/src/convert/coverage.test.ts"],"estimate":"L"},
  {"id":"WP-H11","title":"convert.* MCP tools (html_to_tree / html_to_page / fidelity_check) + persist orchestrator","layer":"html","phase":"v1","depends_on":["WP-F03","WP-F04","WP-F05","WP-T01","WP-T02","WP-P02","WP-P03","WP-P05","WP-P06","WP-H03","WP-H04","WP-H05","WP-H06","WP-H07","WP-H08","WP-H09","WP-H10","WP-S01","WP-S03"],"files_owned":["packages/server/src/convert/pipeline.ts","packages/server/src/convert/pipeline.test.ts","packages/server/src/convert/ports.ts","packages/server/src/tools/convert.ts","packages/server/src/tools/convert.test.ts"],"estimate":"L"},
  {"id":"WP-H12","title":"HTML-to-native golden corpus + smoke fixtures (S3-anchored regression data)","layer":"html","phase":"v1","depends_on":["WP-F03","WP-F06","WP-S03"],"files_owned":["packages/shared/fixtures/html/sections/01-hero/input.html","packages/shared/fixtures/html/sections/01-hero/input.css","packages/shared/fixtures/html/sections/01-hero/expected.coverage.json","packages/shared/fixtures/html/sections/01-hero/expected.a11y.json","packages/shared/fixtures/html/sections/02-pricing-table/input.html","packages/shared/fixtures/html/sections/02-pricing-table/input.css","packages/shared/fixtures/html/sections/02-pricing-table/expected.coverage.json","packages/shared/fixtures/html/sections/02-pricing-table/expected.a11y.json","packages/shared/fixtures/html/sections/03-feature-grid/input.html","packages/shared/fixtures/html/sections/03-feature-grid/input.css","packages/shared/fixtures/html/sections/03-feature-grid/expected.coverage.json","packages/shared/fixtures/html/sections/03-feature-grid/expected.a11y.json","packages/shared/fixtures/html/sections/04-cta-banner/input.html","packages/shared/fixtures/html/sections/04-cta-banner/input.css","packages/shared/fixtures/html/sections/04-cta-banner/expected.coverage.json","packages/shared/fixtures/html/sections/04-cta-banner/expected.a11y.json","packages/shared/fixtures/html/sections/05-rich-text-card/input.html","packages/shared/fixtures/html/sections/05-rich-text-card/input.css","packages/shared/fixtures/html/sections/05-rich-text-card/expected.coverage.json","packages/shared/fixtures/html/sections/05-rich-text-card/expected.a11y.json","packages/shared/fixtures/html/corpus.manifest.json","packages/shared/fixtures/envelopes/smoke.elementor.convert.html_to_tree.json","packages/shared/fixtures/envelopes/smoke.elementor.convert.html_to_page.json","packages/shared/fixtures/envelopes/smoke.elementor.convert.fidelity_check.json"],"estimate":"M"},
  {"id":"WP-R01","title":"PHP Pro controller bootstrap + Theme Builder routes","layer":"php","phase":"ULTRA","depends_on":["WP-F01","WP-F02","WP-F05","WP-P01","WP-P02","WP-P03","WP-P04","WP-P05","WP-P06","WP-S01"],"files_owned":["plugin/elementor-ultra-mcp/includes/rest/class-pro-controller.php","plugin/elementor-ultra-mcp/includes/pro/class-pro-gate.php","plugin/elementor-ultra-mcp/includes/pro/class-conditions-helper.php","plugin/elementor-ultra-mcp/includes/pro/class-theme-builder-service.php"],"estimate":"L"},
  {"id":"WP-R02","title":"PHP Pro Popups — create + display-settings + conditions","layer":"php","phase":"ULTRA","depends_on":["WP-F01","WP-F02","WP-F05","WP-P01","WP-P02","WP-P03","WP-P04","WP-P05","WP-P06","WP-S01","WP-R01"],"files_owned":["plugin/elementor-ultra-mcp/includes/pro/class-popup-service.php","plugin/elementor-ultra-mcp/includes/pro/class-display-settings-helper.php"],"estimate":"M"},
  {"id":"WP-R03","title":"PHP Pro Forms — build widget + fields-repeater + actions + list_actions","layer":"php","phase":"ULTRA","depends_on":["WP-F01","WP-F02","WP-F05","WP-P01","WP-P02","WP-P03","WP-P04","WP-P05","WP-P06","WP-S01","WP-R01"],"files_owned":["plugin/elementor-ultra-mcp/includes/pro/class-form-builder-service.php","plugin/elementor-ultra-mcp/includes/pro/class-form-mapper.php"],"estimate":"L"},
  {"id":"WP-R04","title":"PHP Pro Loop Builder — create loop-item + bind-grid query","layer":"php","phase":"ULTRA","depends_on":["WP-F01","WP-F02","WP-F05","WP-P01","WP-P02","WP-P03","WP-P04","WP-P05","WP-P06","WP-S01","WP-R01"],"files_owned":["plugin/elementor-ultra-mcp/includes/pro/class-loop-service.php","plugin/elementor-ultra-mcp/includes/pro/class-loop-query-mapper.php"],"estimate":"M"},
  {"id":"WP-R05","title":"PHP Pro Dynamic Tags — bind (tag_to_text mirror) + list + per-tag schema","layer":"php","phase":"ULTRA","depends_on":["WP-F01","WP-F02","WP-F05","WP-P01","WP-P02","WP-P03","WP-P04","WP-P06","WP-P07","WP-R01"],"files_owned":["plugin/elementor-ultra-mcp/includes/pro/class-dynamic-tags-service.php","plugin/elementor-ultra-mcp/includes/pro/class-dynamic-encoder.php"],"estimate":"M"},
  {"id":"WP-R06","title":"PHP Pro WooCommerce — context-validated add-widget (ULTRA)","layer":"php","phase":"ULTRA","depends_on":["WP-F01","WP-F02","WP-F05","WP-P01","WP-P02","WP-P03","WP-P04","WP-P05","WP-P06","WP-S01","WP-R01"],"files_owned":["plugin/elementor-ultra-mcp/includes/pro/class-woo-service.php","plugin/elementor-ultra-mcp/includes/pro/class-woo-context-validator.php"],"estimate":"M"},
  {"id":"WP-R07","title":"TS Pro Theme Builder tools (create / set_conditions / get_conditions_config) + theme-builder-from-spec prompt","layer":"ts","phase":"ULTRA","depends_on":["WP-F01","WP-F03","WP-F04","WP-F05","WP-T01","WP-T04","WP-T05","WP-R01"],"files_owned":["packages/server/src/tools/pro/theme.ts","packages/server/src/tools/pro/theme.test.ts","packages/server/src/prompts/theme-builder-from-spec.ts","packages/server/src/prompts/theme-builder-from-spec.test.ts","packages/shared/fixtures/envelopes/smoke.elementor.pro.theme.create.json"],"estimate":"M"},
  {"id":"WP-R08","title":"TS Pro Popup tools (create / set_triggers / set_timing)","layer":"ts","phase":"ULTRA","depends_on":["WP-F01","WP-F03","WP-F04","WP-F05","WP-T01","WP-T04","WP-T05","WP-R02"],"files_owned":["packages/server/src/tools/pro/popup.ts","packages/server/src/tools/pro/popup.test.ts","packages/shared/fixtures/envelopes/smoke.elementor.pro.popup.create.json"],"estimate":"M"},
  {"id":"WP-R09","title":"TS Pro Form tools (build / list_actions)","layer":"ts","phase":"ULTRA","depends_on":["WP-F01","WP-F03","WP-F04","WP-F05","WP-T01","WP-T04","WP-T05","WP-R03"],"files_owned":["packages/server/src/tools/pro/form.ts","packages/server/src/tools/pro/form.test.ts","packages/shared/fixtures/envelopes/smoke.elementor.pro.form.build.json"],"estimate":"M"},
  {"id":"WP-R10","title":"TS Pro Loop tools (create_item / bind_grid)","layer":"ts","phase":"ULTRA","depends_on":["WP-F01","WP-F03","WP-F04","WP-F05","WP-T01","WP-T04","WP-T05","WP-R04"],"files_owned":["packages/server/src/tools/pro/loop.ts","packages/server/src/tools/pro/loop.test.ts","packages/shared/fixtures/envelopes/smoke.elementor.pro.loop.create_item.json"],"estimate":"M"},
  {"id":"WP-R11","title":"TS Pro Dynamic tools (bind / list_tags) + shared tag_to_text encoder","layer":"ts","phase":"ULTRA","depends_on":["WP-F01","WP-F03","WP-F04","WP-F05","WP-T01","WP-T04","WP-T05","WP-R05"],"files_owned":["packages/server/src/tools/pro/dynamic.ts","packages/server/src/tools/pro/dynamic.test.ts","packages/server/src/authoring/dynamic-encoder.ts","packages/server/src/authoring/dynamic-encoder.test.ts","packages/shared/fixtures/envelopes/smoke.elementor.pro.dynamic.list_tags.json"],"estimate":"M"},
  {"id":"WP-R12","title":"TS Pro WooCommerce tool (add_widget, context-validated) — ULTRA","layer":"ts","phase":"ULTRA","depends_on":["WP-F01","WP-F03","WP-F04","WP-F05","WP-T01","WP-T04","WP-T05","WP-R06"],"files_owned":["packages/server/src/tools/pro/woo.ts","packages/server/src/tools/pro/woo.test.ts","packages/shared/fixtures/envelopes/smoke.elementor.pro.woo.add_widget.json"],"estimate":"S"},
  {"id":"WP-F01","title":"Repo scaffold — pnpm/turbo monorepo, TS packages, base tooling, wp-env (plugin bootstrap is WP-P01)","layer":"foundation","phase":"foundation","depends_on":[],"files_owned":["package.json","pnpm-workspace.yaml","turbo.json",".gitignore",".npmrc",".nvmrc",".editorconfig","tsconfig.base.json",".prettierrc.json",".prettierignore","eslint.config.mjs",".wp-env.json","README.md","packages/server/package.json","packages/server/tsconfig.json","packages/server/src/index.ts","packages/shared/package.json","packages/shared/tsconfig.json","packages/shared/src/index.ts"],"estimate":"M"},
  {"id":"WP-F02","title":"Realize the REST contract — shared TS types, OpenAPI types, typed client/route stubs","layer":"foundation","phase":"foundation","depends_on":["WP-F01"],"files_owned":["packages/shared/src/rest/types.ts","packages/shared/src/rest/envelopes.ts","packages/shared/src/rest/routes.ts","packages/shared/src/rest/index.ts","packages/server/src/wp/routes.ts","packages/server/src/wp/client.ts","packages/server/src/wp/types.ts","scripts/gen-openapi-types.mjs"],"estimate":"L"},
  {"id":"WP-F03","title":"Realize the authoring contract — shared TS types, JSON-schema exports, prefilter validators","layer":"foundation","phase":"foundation","depends_on":["WP-F01"],"files_owned":["packages/shared/schemas/atomic-prop-types.schema.json","packages/shared/schemas/style-variant.schema.json","packages/shared/schemas/element-node.schema.json","packages/shared/schemas/page-tree.schema.json","packages/shared/schemas/diff.schema.json","packages/shared/schemas/index.ts","packages/server/src/authoring/contract.ts","packages/server/src/authoring/envelopes.ts","packages/server/src/authoring/ids.ts","packages/server/src/authoring/prefilter.ts","scripts/sync-schemas.mjs"],"estimate":"L"},
  {"id":"WP-F04","title":"Realize the tool catalog — zod schema modules + data-driven tool-registry skeleton","layer":"foundation","phase":"foundation","depends_on":["WP-F01","WP-F03"],"files_owned":["packages/server/src/catalog/tools.ts","packages/server/src/catalog/resources.ts","packages/server/src/catalog/prompts.ts","packages/server/src/catalog/profiles.ts","packages/server/src/catalog/registry.ts","packages/server/src/catalog/index.ts","packages/server/src/catalog/schemas/shared.ts","packages/server/src/catalog/schemas/discovery.ts","packages/server/src/catalog/schemas/page.ts","packages/server/src/catalog/schemas/widget.ts","packages/server/src/catalog/schemas/design.ts","packages/server/src/catalog/schemas/media.ts","packages/server/src/catalog/schemas/nav.ts","packages/server/src/catalog/schemas/templates.ts","packages/server/src/catalog/schemas/pro.ts","packages/server/src/catalog/schemas/convert.ts","packages/server/src/catalog/schemas/ops.ts","packages/server/src/catalog/schemas/meta.ts"],"estimate":"L"},
  {"id":"WP-F05","title":"Error taxonomy (TS classes + PHP WP_Error map) + capability/experiment probe (both sides)","layer":"foundation","phase":"foundation","depends_on":["WP-F01"],"files_owned":["packages/shared/src/errors/codes.ts","packages/shared/src/errors/payload.ts","packages/shared/src/errors/index.ts","packages/shared/src/capabilities/types.ts","packages/shared/src/capabilities/index.ts","packages/shared/schemas/error-payload.schema.json","packages/shared/schemas/capabilities.schema.json","packages/server/src/wp/errors.ts","plugin/elementor-ultra-mcp/includes/core/class-error-codes.php","plugin/elementor-ultra-mcp/includes/core/class-wp-error-map.php","plugin/elementor-ultra-mcp/includes/core/class-capabilities.php","packages/server/src/tools/discovery-capabilities.ts"],"estimate":"M"},
  {"id":"WP-F06","title":"Golden-fixtures + contract-test harness (fixtures dir, runners, PHP dry_run round-trip, Inspector smoke)","layer":"foundation","phase":"foundation","depends_on":["WP-F01","WP-F03","WP-F05"],"files_owned":["packages/shared/fixtures/README.md","packages/shared/fixtures/envelope.schema.json","packages/shared/fixtures/corpus.manifest.json","packages/shared/fixtures/trees/v4/valid/.gitkeep","packages/shared/fixtures/trees/v4/invalid/.gitkeep","packages/shared/fixtures/trees/v3/valid/.gitkeep","packages/shared/fixtures/trees/v3/invalid/.gitkeep","packages/shared/fixtures/trees/design/.gitkeep","packages/shared/fixtures/schemas/.gitkeep","packages/shared/fixtures/html/.gitkeep","packages/shared/fixtures/roundtrip/.gitkeep","packages/shared/fixtures/envelopes/.gitkeep","packages/server/src/test-harness/fixture-loader.ts","packages/server/src/test-harness/prefilter-subset.test.ts","packages/server/src/test-harness/dry-run-roundtrip.contract.ts","packages/server/src/test-harness/roundtrip-identity.contract.ts","packages/server/src/test-harness/inspector-smoke.ts","packages/server/src/test-harness/index.ts","scripts/fixtures-validate.mjs","scripts/fixtures-snapshot-schemas.mjs","plugin/elementor-ultra-mcp/tests/bootstrap.php","plugin/elementor-ultra-mcp/tests/class-fixture-loader.php","plugin/elementor-ultra-mcp/tests/test-dry-run-fixtures.php","plugin/elementor-ultra-mcp/phpunit.xml.dist"],"estimate":"L"},
  {"id":"WP-F07","title":"CI pipeline including the schema-drift required check + SDK-2.x guard + wp-env matrix","layer":"foundation","phase":"foundation","depends_on":["WP-F01","WP-F06"],"files_owned":[".github/workflows/ci.yml",".github/workflows/drift.yml",".github/workflows/release.yml",".github/workflows/_setup-node.yml",".github/workflows/_setup-wp-env.yml","scripts/ci/check-sdk-version.mjs","scripts/ci/check-co-author-trailer.mjs","scripts/ci/wp-env-up.sh",".github/CODEOWNERS"],"estimate":"M"},
  {"id":"WP-S01","title":"Spike — headless atomic save + CSS priming (which prime-css approach emits front-end CSS)","layer":"spike","phase":"foundation","depends_on":["WP-F01"],"files_owned":["spec/spikes/S01-headless-atomic-save-css-priming.md","spec/spikes/scripts/s01-save-atomic-tree.php","spec/spikes/scripts/s01-prime-approach-a-loopback.php","spec/spikes/scripts/s01-prime-approach-b-programmatic.php","spec/spikes/scripts/s01-assert-css.mjs","spec/spikes/fixtures/s01-atomic-hero.json"],"estimate":"M"},
  {"id":"WP-S02","title":"Spike — template-library save/import of atomic V4 (Source_Local::save_item correctness)","layer":"spike","phase":"foundation","depends_on":["WP-F01"],"files_owned":["spec/spikes/S02-template-library-atomic-save.md","spec/spikes/scripts/s02-save-template.php","spec/spikes/scripts/s02-import-template.php","spec/spikes/scripts/s02-assert-roundtrip.mjs","spec/spikes/fixtures/s02-atomic-block.json"],"estimate":"M"},
  {"id":"WP-S03","title":"Spike — HTML→native coverage baseline on real marketing sections (set the S3 number)","layer":"spike","phase":"foundation","depends_on":["WP-F01","WP-F03"],"files_owned":["spec/spikes/S03-html-native-coverage-baseline.md","spec/spikes/scripts/s03-convert-section.mjs","spec/spikes/scripts/s03-measure-coverage.mjs","spec/spikes/fixtures/sections/01-pricing-table/input.html","spec/spikes/fixtures/sections/01-pricing-table/input.css","spec/spikes/fixtures/sections/02-hero/input.html","spec/spikes/fixtures/sections/02-hero/input.css","spec/spikes/fixtures/sections/03-feature-grid/input.html","spec/spikes/fixtures/sections/03-feature-grid/input.css","spec/spikes/fixtures/sections/04-testimonial/input.html","spec/spikes/fixtures/sections/04-testimonial/input.css","spec/spikes/fixtures/sections/05-cta-banner/input.html","spec/spikes/fixtures/sections/05-cta-banner/input.css"],"estimate":"L"},
  {"id":"WP-S04","title":"Spike — Document::save_settings() merge-vs-replace semantics (page.update_settings)","layer":"spike","phase":"foundation","depends_on":["WP-F01"],"files_owned":["spec/spikes/S04-save-settings-merge-semantics.md","spec/spikes/scripts/s04-probe-merge.php"],"estimate":"S"},
  {"id":"WP-S05","title":"Spike — UPDATE_CLASS capability presence for the agent user on a target install","layer":"spike","phase":"foundation","depends_on":["WP-F01"],"files_owned":["spec/spikes/S05-update-class-capability-presence.md","spec/spikes/scripts/s05-probe-update-class.php"],"estimate":"S"},
  {"id":"WP-S06","title":"Spike — Application Passwords over plain HTTP on LocalWP/wp-env (the local auth path)","layer":"spike","phase":"foundation","depends_on":["WP-F01"],"files_owned":["spec/spikes/S06-app-password-over-http.md","spec/spikes/scripts/s06-probe-app-password.mjs","spec/spikes/scripts/s06-enable-local-filter.php"],"estimate":"S"},
  {"id":"WP-S07","title":"Spike — wp elementor flush-css --network reliability on current multisite","layer":"spike","phase":"foundation","depends_on":["WP-F01"],"files_owned":["spec/spikes/S07-flush-css-network-multisite.md","spec/spikes/scripts/s07-multisite-flush.sh","spec/spikes/scripts/s07-assert-cache-cleared.mjs"],"estimate":"S"},
  {"id":"WP-Q01","title":"QA — golden-tree fixtures per atomic widget (+ V3 + design) with dry_run verdicts","layer":"qa","phase":"MVP","depends_on":["WP-F03","WP-F05","WP-F06","WP-P03"],"files_owned":["packages/shared/fixtures/trees/v4/valid/e-heading.basic.json","packages/shared/fixtures/trees/v4/valid/e-paragraph.basic.json","packages/shared/fixtures/trees/v4/valid/e-button.with-link.json","packages/shared/fixtures/trees/v4/valid/e-image.id-only.json","packages/shared/fixtures/trees/v4/valid/e-div-block.flex-row.json","packages/shared/fixtures/trees/v4/valid/e-flexbox.column.json","packages/shared/fixtures/trees/v4/valid/hero-section.composite.json","packages/shared/fixtures/trees/v4/valid/styles.states-breakpoints.json","packages/shared/fixtures/trees/v4/invalid/e-heading.bad-tag-enum.json","packages/shared/fixtures/trees/v4/invalid/e-div-block.image-src-id-and-url.json","packages/shared/fixtures/trees/v4/invalid/e-button.missing-required-prop.json","packages/shared/fixtures/trees/v4/invalid/local-style.id-not-in-classes.json","packages/shared/fixtures/trees/v4/invalid/duplicate-element-id.json","packages/shared/fixtures/trees/v4/invalid/unknown-widget-type.json","packages/shared/fixtures/trees/v3/valid/heading.basic.json","packages/shared/fixtures/trees/v3/valid/container.flex.json","packages/shared/fixtures/trees/v3/invalid/unknown-widgettype.json","packages/shared/fixtures/trees/design/global-classes.upsert-diff.json","packages/shared/fixtures/trees/design/variables.batch.json","packages/shared/fixtures/trees/INDEX.md"],"estimate":"L"},
  {"id":"WP-Q02","title":"QA — schema-drift test + baseline snapshots (get_props_schema vs pre-filter)","layer":"qa","phase":"foundation","depends_on":["WP-F03","WP-F06"],"files_owned":["packages/server/src/test-harness/schema-drift.test.ts","packages/server/src/test-harness/schema-normalize.ts","packages/shared/fixtures/schemas/e-heading.schema.json","packages/shared/fixtures/schemas/e-paragraph.schema.json","packages/shared/fixtures/schemas/e-button.schema.json","packages/shared/fixtures/schemas/e-image.schema.json","packages/shared/fixtures/schemas/e-div-block.schema.json","packages/shared/fixtures/schemas/e-flexbox.schema.json","packages/shared/fixtures/schemas/e-svg.schema.json","packages/shared/fixtures/schemas/e-divider.schema.json","packages/shared/fixtures/schemas/e-youtube.schema.json","packages/shared/fixtures/schemas/e-self-hosted-video.schema.json","packages/shared/fixtures/schemas/e-tabs.schema.json","packages/shared/fixtures/schemas/e-tabs-menu.schema.json","packages/shared/fixtures/schemas/e-tab.schema.json","packages/shared/fixtures/schemas/e-tabs-content-area.schema.json","packages/shared/fixtures/schemas/e-tab-content.schema.json","packages/shared/fixtures/schemas/style-schema.json","packages/shared/fixtures/schemas/INDEX.md"],"estimate":"M"},
  {"id":"WP-Q03","title":"QA — MCP Inspector smoke suite + lean-tool smoke payloads","layer":"qa","phase":"MVP","depends_on":["WP-F04","WP-F06","WP-H12"],"files_owned":["packages/server/src/test-harness/smoke-driver.ts","packages/server/src/test-harness/smoke.test.ts","packages/shared/fixtures/envelopes/smoke.elementor.tools.search.json","packages/shared/fixtures/envelopes/smoke.elementor.site.capabilities.json","packages/shared/fixtures/envelopes/smoke.elementor.pages.list.json","packages/shared/fixtures/envelopes/smoke.elementor.page.get_structure.json","packages/shared/fixtures/envelopes/smoke.elementor.page.create.json","packages/shared/fixtures/envelopes/smoke.elementor.page.build.json","packages/shared/fixtures/envelopes/smoke.elementor.page.dry_run.json","packages/shared/fixtures/envelopes/smoke.elementor.schema.widget.json","packages/shared/fixtures/envelopes/smoke.elementor.schema.styles.json","packages/shared/fixtures/envelopes/smoke.elementor.breakpoints.get.json","packages/shared/fixtures/envelopes/smoke.elementor.widget.insert.json","packages/shared/fixtures/envelopes/smoke.elementor.widget.update_settings.json","packages/shared/fixtures/envelopes/smoke.elementor.design.classes.list.json","packages/shared/fixtures/envelopes/smoke.elementor.design.classes.upsert.json","packages/shared/fixtures/envelopes/smoke.elementor.design.variables.list.json","packages/shared/fixtures/envelopes/smoke.elementor.media.sideload_url.json","packages/shared/fixtures/envelopes/INDEX.md"],"estimate":"M"},
  {"id":"WP-Q04","title":"QA — HTML→native corpus regression (S3-anchored coverage + a11y + stripped-text + dry_run)","layer":"qa","phase":"v1","depends_on":["WP-F06","WP-S03","WP-P03","WP-H12"],"files_owned":["packages/server/src/test-harness/html-corpus.contract.ts"],"estimate":"L"},
  {"id":"WP-Q05","title":"QA — round-trip identity tests (build → get_structure → normalize → equal)","layer":"qa","phase":"MVP","depends_on":["WP-F03","WP-F06","WP-P03"],"files_owned":["packages/server/src/test-harness/roundtrip-identity.test.ts","packages/server/src/authoring/contract.normalize.test.ts","packages/shared/fixtures/roundtrip/e-heading.basic.roundtrip.json","packages/shared/fixtures/roundtrip/hero-section.roundtrip.json","packages/shared/fixtures/roundtrip/e-image.id-only.roundtrip.json","packages/shared/fixtures/roundtrip/styles.local-and-global.roundtrip.json","packages/shared/fixtures/roundtrip/v3.container.roundtrip.json","packages/shared/fixtures/roundtrip/INDEX.md"],"estimate":"M"},
  {"id":"WP-Q06","title":"QA — render assertion (S01 regression): save atomic tree → prime-css → assert CSS rules","layer":"qa","phase":"MVP","depends_on":["WP-F06","WP-S01","WP-P03","WP-P04","WP-P05"],"files_owned":["plugin/elementor-ultra-mcp/tests/test-render-assertion.php","plugin/elementor-ultra-mcp/tests/class-css-rule-extractor.php","packages/server/src/test-harness/render-assertion.contract.ts","packages/shared/fixtures/trees/v4/valid/render-assert.hero.json","packages/shared/fixtures/trees/v4/valid/render-assert.global-class.json","packages/shared/fixtures/trees/INDEX-render.md"],"estimate":"M"},
  {"id":"WP-Q07","title":"QA — end-to-end agency site from brief (pages + theme builder + design system + popups + rollback + compensation)","layer":"qa","phase":"ULTRA","depends_on":["WP-F06","WP-S01","WP-P03","WP-P04","WP-P05","WP-Q06"],"files_owned":["packages/server/src/test-harness/e2e-agency-site.contract.ts","packages/server/src/test-harness/e2e-scenario.ts","packages/shared/fixtures/e2e/brief.agency-site.json","packages/shared/fixtures/e2e/expected.outcomes.json","packages/shared/fixtures/e2e/INDEX.md"],"estimate":"L"},
  {"id":"WP-Q08","title":"QA/release — npx-distributable server packaging + plugin zip packaging + release process","layer":"qa","phase":"v1","depends_on":["WP-F01","WP-F07"],"files_owned":["scripts/release/pack-server.mjs","scripts/release/pack-plugin.mjs","scripts/release/verify-package.mjs","scripts/release/bump-version.mjs","packages/server/.npmignore","packages/server/README.md","plugin/elementor-ultra-mcp/.distignore","RELEASE.md","CHANGELOG.md"],"estimate":"M"}
];

const byId = new Map(manifest.map(w => [w.id, w]));
const allIds = new Set(byId.keys());

// ---- Validation: undefined deps ----
const undefinedDeps = [];
for (const w of manifest) {
  for (const d of w.depends_on) {
    if (!allIds.has(d)) undefinedDeps.push({ wp: w.id, missing: d });
  }
}

// ---- Cycle detection (DFS) ----
const cycles = [];
const WHITE = 0, GRAY = 1, BLACK = 2;
const color = new Map([...allIds].map(id => [id, WHITE]));
const stack = [];
function dfs(id) {
  color.set(id, GRAY);
  stack.push(id);
  for (const d of (byId.get(id)?.depends_on ?? [])) {
    if (!allIds.has(d)) continue;
    if (color.get(d) === GRAY) {
      const idx = stack.indexOf(d);
      cycles.push([...stack.slice(idx), d]);
    } else if (color.get(d) === WHITE) {
      dfs(d);
    }
  }
  stack.pop();
  color.set(id, BLACK);
}
for (const id of allIds) if (color.get(id) === WHITE) dfs(id);

// ---- Wave computation: wave = 1 + max(wave of deps); deps-free = 0 ----
const wave = new Map();
function computeWave(id, seen = new Set()) {
  if (wave.has(id)) return wave.get(id);
  if (seen.has(id)) return 0; // cycle guard
  seen.add(id);
  const deps = (byId.get(id)?.depends_on ?? []).filter(d => allIds.has(d));
  let w;
  if (deps.length === 0) {
    w = 0;
  } else {
    w = 1 + Math.max(...deps.map(d => computeWave(d, seen)));
  }
  wave.set(id, w);
  return w;
}
for (const id of allIds) computeWave(id);

// ---- File conflict detection: same-wave WPs sharing a files_owned path ----
// Treat glob patterns by their directory prefix for overlap purposes (report exact-string dupes only as hard conflicts).
function fileKeys(w) {
  return w.files_owned.map(f => {
    // strip glob and parenthetical notes for overlap key
    let k = f.replace(/\s*\(.*$/, '').trim();
    return k;
  });
}
const sameWaveConflicts = [];
const waveGroups = new Map();
for (const w of manifest) {
  const ww = wave.get(w.id);
  if (!waveGroups.has(ww)) waveGroups.set(ww, []);
  waveGroups.get(ww).push(w);
}
for (const [ww, group] of waveGroups) {
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const a = new Set(fileKeys(group[i]));
      const b = fileKeys(group[j]);
      for (const f of b) {
        if (a.has(f)) sameWaveConflicts.push({ wave: ww, a: group[i].id, b: group[j].id, file: f });
      }
    }
  }
}

// ---- Glob/prefix soft-overlap check across same-wave (different WPs writing into same dir via globs) ----
const softOverlaps = [];
function expandPrefix(f) {
  // For a glob like dir/*.json, key is dir/
  const m = f.match(/^(.*\/)\*/);
  if (m) return m[1];
  return null;
}
for (const [ww, group] of waveGroups) {
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const aGlobs = group[i].files_owned.map(expandPrefix).filter(Boolean);
      const bFiles = group[j].files_owned.map(f => f.replace(/\s*\(.*$/, '').trim());
      for (const g of aGlobs) {
        for (const bf of bFiles) {
          if (bf.startsWith(g) && !sameWaveConflicts.find(c => c.a === group[i].id && c.b === group[j].id && c.file === bf)) {
            softOverlaps.push({ wave: ww, glob_owner: group[i].id, glob: g, other: group[j].id, file: bf });
          }
        }
      }
    }
  }
}

// ---- Parallel groups: within a wave, partition into file-disjoint sets via greedy bin packing ----
// Since we want max concurrency and (assuming no conflicts) all in a wave are disjoint, the
// natural parallel_group = the wave itself when conflict-free. We still bin-pack to be safe.
function intervalKey(f) { return f.replace(/\s*\(.*$/, '').trim(); }
function wpFileSet(w) {
  // include glob prefixes as pseudo-files to catch overlap
  const set = new Set();
  for (const f of w.files_owned) {
    const k = intervalKey(f);
    set.add(k);
    const p = expandPrefix(k);
    if (p) set.add('PREFIX:' + p);
  }
  return set;
}
function overlaps(setA, w) {
  const fb = wpFileSet(w);
  for (const f of fb) {
    if (setA.has(f)) return true;
    // a concrete file in w under a prefix owned by setA
    if (!f.startsWith('PREFIX:')) {
      for (const a of setA) {
        if (a.startsWith('PREFIX:') && f.startsWith(a.slice('PREFIX:'.length))) return true;
      }
    } else {
      const pfx = f.slice('PREFIX:'.length);
      for (const a of setA) {
        if (!a.startsWith('PREFIX:') && a.startsWith(pfx)) return true;
      }
    }
  }
  return false;
}

const parallelGroupOf = new Map();
for (const [ww, group] of [...waveGroups].sort((a,b)=>a[0]-b[0])) {
  // sort deterministically by id
  const sorted = [...group].sort((a,b)=>a.id.localeCompare(b.id));
  const bins = []; // each bin: {set, members}
  for (const w of sorted) {
    let placed = false;
    for (const bin of bins) {
      if (!overlaps(bin.set, w)) {
        for (const f of wpFileSet(w)) bin.set.add(f);
        bin.members.push(w.id);
        placed = true;
        break;
      }
    }
    if (!placed) {
      const set = wpFileSet(w);
      bins.push({ set, members: [w.id] });
    }
  }
  bins.forEach((bin, idx) => {
    const label = `W${ww}` + (bins.length > 1 ? `-${String.fromCharCode(65+idx)}` : '');
    for (const m of bin.members) parallelGroupOf.set(m, label);
  });
}

// ---- Critical path (longest dependency chain) ----
const longestFrom = new Map();
function longest(id) {
  if (longestFrom.has(id)) return longestFrom.get(id);
  const deps = (byId.get(id)?.depends_on ?? []).filter(d => allIds.has(d));
  let best = [id];
  for (const d of deps) {
    const path = longest(d);
    if (path.length + 1 > best.length) best = [...path, id];
  }
  longestFrom.set(id, best);
  return best;
}
let critical = [];
for (const id of allIds) {
  const p = longest(id);
  if (p.length > critical.length) critical = p;
}

// ---- Emit work-packages.json ----
const indexArr = manifest
  .slice()
  .sort((a, b) => (wave.get(a.id) - wave.get(b.id)) || a.id.localeCompare(b.id))
  .map(w => ({
    id: w.id,
    title: w.title,
    layer: w.layer,
    phase: w.phase,
    depends_on: w.depends_on,
    files_owned: w.files_owned,
    estimate: w.estimate,
    wave: wave.get(w.id),
    parallel_group: parallelGroupOf.get(w.id),
  }));

writeFileSync('/Users/shahmir/projects/elementor-mcp/spec/work-packages.json', JSON.stringify(indexArr, null, 2) + '\n');

// ---- Emit computed metadata for the build-plan generator ----
const maxWave = Math.max(...wave.values());
const waveTable = [];
for (let w = 0; w <= maxWave; w++) {
  const ids = manifest.filter(x => wave.get(x.id) === w).map(x => x.id).sort();
  waveTable.push({ wave: w, ids });
}
const meta = {
  wp_total: manifest.length,
  maxWave,
  waveTable,
  parallelGroups: [...new Set([...parallelGroupOf.values()])].sort(),
  parallelGroupMembers: Object.fromEntries(
    [...new Set([...parallelGroupOf.values()])].sort().map(g => [g, [...parallelGroupOf.entries()].filter(([,v])=>v===g).map(([k])=>k).sort()])
  ),
  critical,
  criticalLen: critical.length,
  undefinedDeps,
  cycles,
  sameWaveConflicts,
  softOverlaps,
};
writeFileSync('/Users/shahmir/projects/elementor-mcp/spec/.dag-meta.json', JSON.stringify(meta, null, 2) + '\n');

console.log('wp_total:', manifest.length);
console.log('maxWave:', maxWave);
console.log('critical path len:', critical.length);
console.log('critical:', critical.join(' -> '));
console.log('undefinedDeps:', JSON.stringify(undefinedDeps));
console.log('cycles:', JSON.stringify(cycles));
console.log('HARD file conflicts (same wave, exact path):', JSON.stringify(sameWaveConflicts, null, 2));
console.log('SOFT glob overlaps (same wave):', JSON.stringify(softOverlaps, null, 2));
console.log('--- wave sizes ---');
for (const wt of waveTable) console.log(`wave ${wt.wave}: ${wt.ids.length} WPs -> ${wt.ids.join(', ')}`);
console.log('--- parallel groups ---');
for (const [g, members] of Object.entries(meta.parallelGroupMembers)) console.log(`${g}: ${members.join(', ')}`);
