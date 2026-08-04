#!/usr/bin/env bash
# Portable one-command local dev site for Elementor Ultra.
# Stands up WordPress + Elementor (free) + the companion plugin, wires everything the stack needs,
# mints an application password, and prints the connection details. Idempotent — safe to re-run.
#
#   bash dev/setup.sh
#
# Requires: Docker (with Compose v2). No licensed binaries, no absolute paths.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="docker compose -f $DIR/docker-compose.yml"
URL="http://localhost:8899"
ADMIN_USER="admin"
ADMIN_PASS="UltraDev!8899"
ADMIN_EMAIL="admin@example.test"
# Newest Elementor in the certified 4.1.x line (>=4.1.4). Override: EXJSX_ELEMENTOR_VERSION=4.2.1 bash dev/setup.sh
EL_VERSION="${EXJSX_ELEMENTOR_VERSION:-4.1.5}"

log() { printf '\033[36m[setup]\033[0m %s\n' "$*"; }
wp()  { $COMPOSE run --rm wpcli "$@"; }

log "starting containers …"
$COMPOSE up -d db wordpress >/dev/null

log "waiting for WordPress to answer …"
until curl -fsS -o /dev/null "$URL" 2>/dev/null; do sleep 2; done

if wp core is-installed >/dev/null 2>&1; then
  log "WordPress already installed — reconfiguring."
else
  log "installing WordPress core …"
  wp core install --url="$URL" --title="Elementor Ultra Dev" \
    --admin_user="$ADMIN_USER" --admin_password="$ADMIN_PASS" --admin_email="$ADMIN_EMAIL" --skip-email
fi

# /wp-json/* routes only resolve under pretty permalinks; the default (plain) serves the homepage
# and every REST call 301s to HTML. This is the #1 local-setup gotcha.
log "enabling pretty permalinks (required for the REST API) …"
wp rewrite structure '/%postname%/' --hard >/dev/null
wp rewrite flush --hard >/dev/null

log "installing Elementor $EL_VERSION (free) from wordpress.org …"
wp plugin install elementor --version="$EL_VERSION" --activate >/dev/null 2>&1 || \
  wp plugin install elementor --activate >/dev/null   # fall back to latest if the pin is gone

log "activating the companion plugin …"
wp plugin activate elementor-ultra-mcp >/dev/null

# Elementor V4 atomic experiments (on by default in recent builds; force them for older ones).
for exp in e_atomic_elements e_classes e_variables; do
  wp option update "elementor_experiment-$exp" active >/dev/null 2>&1 || true
done

log "minting an application password for the agent …"
APP_PASS="$(wp user application-password create "$ADMIN_USER" elementor-ultra --porcelain 2>/dev/null | tr -d '\r')"

cat <<SUMMARY

  ✓ Elementor Ultra dev site is up.

  WordPress   $URL/wp-admin   ($ADMIN_USER / $ADMIN_PASS)
  Elementor   $EL_VERSION (free) + companion plugin active
  App password (for MCP + exjsx deploy):
              WP_URL=$URL
              WP_USER=$ADMIN_USER
              WP_APP_PASSWORD=$APP_PASS

  Verify:  curl -u $ADMIN_USER:$APP_PASS $URL/wp-json/elementor-ultra/v1/site/capabilities
  Stop:    docker compose -f $DIR/docker-compose.yml down          (keep data)
  Reset:   docker compose -f $DIR/docker-compose.yml down -v       (wipe data)

SUMMARY
