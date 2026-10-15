#!/usr/bin/env sh
# Roll out IMAGE to APP_ENV on this host and wait until the api is healthy.
# Usage: APP_ENV=staging|production IMAGE=<ref> [COMPOSE_PROFILES=bundled-db] ./deploy.sh
set -eu
cd "$(dirname "$0")"

: "${APP_ENV:?APP_ENV is required (staging|production)}"
: "${IMAGE:?IMAGE is required}"
case "$APP_ENV" in staging|production) ;; *) echo "unknown APP_ENV $APP_ENV" >&2; exit 2 ;; esac

for f in secrets/database_url; do
  [ -s "$f" ] || { echo "missing secret file deploy/$f" >&2; exit 1; }
done
case "${COMPOSE_PROFILES:-}" in
  *bundled-db*) [ -s secrets/postgres_password ] || { echo "missing secret file deploy/secrets/postgres_password" >&2; exit 1; } ;;
  *) [ -e secrets/postgres_password ] || : > secrets/postgres_password ;; # compose requires the file to exist
esac
chmod 600 secrets/* 2>/dev/null || true

export APP_ENV IMAGE
docker compose pull api
docker compose up -d --wait --wait-timeout 120
docker compose ps
