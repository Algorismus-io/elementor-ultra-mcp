#!/usr/bin/env bash
#
# WP-F07 — boot wp-env for the contract / drift / smoke suites and activate the V4 experiments
# the fixtures `require` (`14-fixtures-harness.md §2`, §3 step 1; `15-engineering-standards.md §7`).
#
# Reused by every wp-env CI job (`_setup-wp-env.yml`, `ci.yml` Stage 2, `drift.yml`). It:
#   1. starts `.wp-env.json` (Elementor 4.1.1 + Pro 4.1.0 + the companion plugin, all pinned),
#   2. waits for the WordPress container to answer,
#   3. activates the required Elementor V4 experiments (`e_atomic_elements`, `e_classes`,
#      `e_variables`) so atomic-tree fixtures are NOT skipped,
#   4. on the Pro leg, also activates the Pro atomic-form experiment; on the FREE-only leg Pro is
#      left INACTIVE so `requires.pro` fixtures SKIP (proving the corpus is green on free installs,
#      `14-fixtures-harness.md §2`).
#
# Idempotent: safe to re-run. Honors:
#   WP_ENV_PRO=1            also activate Pro experiments (Pro matrix leg). Default: free-only.
#   WP_ENV_PORT=8888        the wp-env "tests" CLI runs against the dev instance by default; override
#                           only if the workflow remaps ports.
#
# NOTE: this script NEVER edits product/runner code (F07 owns CI only). It only drives `wp-env` +
# `wp-cli`. The actual contract/drift/smoke RUNNERS are owned by WP-F06/WP-Q##.
set -euo pipefail

PRO="${WP_ENV_PRO:-0}"

# Experiments the contract/drift/smoke fixtures require (Spike SUMMARY §1; `.wp-env.json` config).
CORE_EXPERIMENTS=(e_atomic_elements e_classes e_variables)
PRO_EXPERIMENTS=(e_pro_atomic_form)

log() { printf '[wp-env-up] %s\n' "$*"; }

# --- 1. start wp-env ---------------------------------------------------------------------------
log 'starting wp-env (Elementor 4.1.1 + Pro 4.1.0 + companion plugin, all pinned in .wp-env.json)...'
pnpm wp-env start --update

# --- 2. wait for readiness ---------------------------------------------------------------------
log 'waiting for WordPress to answer...'
ready=0
for i in $(seq 1 60); do
  if pnpm wp-env run cli wp core is-installed >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  log 'ERROR: WordPress did not become ready in time.'
  pnpm wp-env logs --watch=false || true
  exit 1
fi
log 'WordPress is up.'

# --- 3. activate the required Elementor V4 experiments ------------------------------------------
# Elementor stores experiment state under the `elementor_experiment-<key>` option; the supported
# Elementor-CLI surface is `wp elementor experiments activate <key>` (4.1.x). We set the option
# directly as a robust fallback so the suites' `requires.experiments` gates pass.
activate_experiment() {
  local key="$1"
  log "activating experiment: ${key}"
  if pnpm wp-env run cli wp elementor experiments activate "${key}" >/dev/null 2>&1; then
    return 0
  fi
  # Fallback: write the option directly (state value 'active').
  pnpm wp-env run cli wp option update "elementor_experiment-${key}" active >/dev/null 2>&1 || \
    log "WARN: could not activate ${key} via CLI or option write"
}

for exp in "${CORE_EXPERIMENTS[@]}"; do
  activate_experiment "${exp}"
done

# --- 4. Pro leg only ---------------------------------------------------------------------------
if [ "${PRO}" = "1" ]; then
  log 'Pro leg: activating Pro experiments + ensuring elementor-pro is active.'
  pnpm wp-env run cli wp plugin activate elementor-pro >/dev/null 2>&1 || \
    log 'WARN: elementor-pro not present (Pro zip not provisioned) — Pro fixtures will SKIP.'
  for exp in "${PRO_EXPERIMENTS[@]}"; do
    activate_experiment "${exp}"
  done
else
  log 'free-only leg: leaving Pro INACTIVE so requires.pro fixtures SKIP (corpus must be green on free).'
  pnpm wp-env run cli wp plugin deactivate elementor-pro >/dev/null 2>&1 || true
fi

# --- 5. activate the companion plugin (bind-mounted via .wp-env.json mappings) ------------------
pnpm wp-env run cli wp plugin activate elementor-ultra-mcp >/dev/null 2>&1 || \
  log 'WARN: companion plugin not activatable (WP-P01 may be pending in this branch).'

# Confirm Elementor pins for the drift guard's benefit.
log 'plugin versions:'
pnpm wp-env run cli wp plugin get elementor --field=version 2>/dev/null || true
pnpm wp-env run cli wp plugin get elementor-pro --field=version 2>/dev/null || true

log 'wp-env is ready for the contract / drift / smoke suites.'

# ── CI: export live-auth env so the smoke/contract steps run LIVE instead of self-skipping ──
if [ -n "${GITHUB_ENV:-}" ]; then
  APP_PASS="$(pnpm wp-env run cli wp user application-password create admin ci-live --porcelain 2>/dev/null | tail -1 | tr -d '\r')"
  if [ -n "${APP_PASS}" ]; then
    {
      echo "WP_URL=http://localhost:8888"
      echo "WP_USER=admin"
      echo "WP_APP_PASSWORD=${APP_PASS}"
    } >> "${GITHUB_ENV}"
    log "CI: App-Password minted and exported (smoke/contract will run live)."
  else
    log "WARN: App-Password mint failed — smoke/contract will self-skip."
  fi
fi
