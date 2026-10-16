#!/usr/bin/env sh
# Roll out IMAGE to APP_ENV on this host and wait until the api is healthy.
# Usage: APP_ENV=staging|production IMAGE=<ref> [COMPOSE_PROFILES=bundled-db] ./deploy.sh
set -eu
cd "$(dirname "$0")"

: "${APP_ENV:?APP_ENV is required (staging|production)}"
: "${IMAGE:?IMAGE is required}"
case "$APP_ENV" in staging|production) ;; *) echo "unknown APP_ENV $APP_ENV" >&2; exit 2 ;; esac

[ -s secrets/database_url ] || { echo "missing secret file deploy/secrets/database_url" >&2; exit 1; }
case "${COMPOSE_PROFILES:-}" in
  *bundled-db*) [ -s secrets/postgres_password ] || { echo "missing secret file deploy/secrets/postgres_password" >&2; exit 1; } ;;
  *) [ -e secrets/postgres_password ] || : > secrets/postgres_password ;; # compose requires the file to exist
esac
# Compose file secrets are bind mounts that keep host ownership, and the image
# runs as uid 65532, so the files must be world-readable inside the container.
# Host-side protection comes from the 0700 directory instead.
chmod 700 secrets
chmod 644 secrets/database_url secrets/postgres_password

export APP_ENV IMAGE
[ "${SKIP_PULL:-0}" = 1 ] || docker compose pull api # SKIP_PULL=1 for a locally built image
docker compose up -d --wait --wait-timeout 120
docker compose ps
