#!/usr/bin/env bash
# Called by the CI deploy jobs: ship deploy/ to DEPLOY_HOST, write the
# environment's secrets there (mode 600, never in the repo or the image) and
# run deploy.sh against IMAGE.
#
# Required env: APP_ENV, IMAGE, DEPLOY_HOST, DEPLOY_USER, DEPLOY_SSH_KEY,
#               DATABASE_URL
# Optional env: POSTGRES_PASSWORD (enables the bundled-db profile),
#               DEPLOY_PATH (default ~/authservice-$APP_ENV), DEPLOY_PORT (22),
#               DEPLOY_KNOWN_HOSTS (pinned host key; otherwise ssh-keyscan),
#               REGISTRY, REGISTRY_USER, REGISTRY_TOKEN (docker login on host)
set -euo pipefail
cd "$(dirname "$0")"

: "${APP_ENV:?}" "${IMAGE:?}" "${DEPLOY_HOST:?}" "${DEPLOY_USER:?}" "${DEPLOY_SSH_KEY:?}"
: "${DATABASE_URL:?DATABASE_URL secret is not set for $APP_ENV}"
case "$APP_ENV" in staging|production) ;; *) echo "unknown APP_ENV $APP_ENV" >&2; exit 2 ;; esac
DEPLOY_PATH="${DEPLOY_PATH:-authservice-$APP_ENV}"
DEPLOY_PORT="${DEPLOY_PORT:-22}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
umask 077
printf '%s\n' "$DEPLOY_SSH_KEY" > "$work/key"
if [ -n "${DEPLOY_KNOWN_HOSTS:-}" ]; then
  printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$work/known_hosts"
else
  ssh-keyscan -p "$DEPLOY_PORT" "$DEPLOY_HOST" > "$work/known_hosts" 2>/dev/null
fi
ssh_opts=(-i "$work/key" -p "$DEPLOY_PORT" -o UserKnownHostsFile="$work/known_hosts" -o StrictHostKeyChecking=yes -o BatchMode=yes)
# Remote commands are built client-side on purpose; values are quoted with q.
# shellcheck disable=SC2029
remote() { ssh "${ssh_opts[@]}" "$DEPLOY_USER@$DEPLOY_HOST" "$@"; }
q() { printf '%q' "$1"; }

remote "mkdir -p $(q "$DEPLOY_PATH")/secrets && chmod 700 $(q "$DEPLOY_PATH")/secrets"
scp -i "$work/key" -P "$DEPLOY_PORT" -o UserKnownHostsFile="$work/known_hosts" -o BatchMode=yes \
  compose.yml deploy.sh "$APP_ENV.env" "$DEPLOY_USER@$DEPLOY_HOST:$DEPLOY_PATH/"

# Secrets travel over stdin so they never show up in a process list.
put_secret() { printf '%s' "$2" | remote "umask 077; cat > $(q "$DEPLOY_PATH/secrets/$1")"; }
put_secret database_url "$DATABASE_URL"
profiles=""
if [ -n "${POSTGRES_PASSWORD:-}" ]; then
  put_secret postgres_password "$POSTGRES_PASSWORD"
  profiles="bundled-db"
fi

if [ -n "${REGISTRY_TOKEN:-}" ]; then
  printf '%s' "$REGISTRY_TOKEN" | remote "docker login $(q "${REGISTRY:-ghcr.io}") -u $(q "${REGISTRY_USER:?}") --password-stdin"
fi

remote "cd $(q "$DEPLOY_PATH") && chmod +x deploy.sh && APP_ENV=$(q "$APP_ENV") IMAGE=$(q "$IMAGE") COMPOSE_PROFILES=$(q "$profiles") ./deploy.sh"
