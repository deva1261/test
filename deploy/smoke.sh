#!/usr/bin/env sh
# Post-deploy smoke test: liveness, readiness (DB reachable), that signup is
# routed and validates, and that protected endpoints reject anonymous callers.
# Usage: ./smoke.sh https://auth.example.com
set -eu
base="${1:?usage: smoke.sh BASE_URL}"
base="${base%/}"

check() { # check PATH EXPECTED_STATUS [METHOD]
  code=$(curl -s -o /dev/null -w '%{http_code}' --retry 5 --retry-all-errors --retry-delay 3 -X "${3:-GET}" "$base$1")
  if [ "$code" != "$2" ]; then
    echo "FAIL ${3:-GET} $1: got $code, want $2" >&2
    exit 1
  fi
  echo "ok   ${3:-GET} $1 -> $code"
}

check /healthz 200
check /readyz 200
check /signup 200
# An empty body is rejected by validation, so this never creates a user.
check /api/auth/signup 400 POST
check /api/auth/me 401
check /api/auth/logout 401 POST
