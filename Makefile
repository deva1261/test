TEST_DATABASE_URL ?= postgres://auth:auth@localhost:5433/auth?sslmode=disable

.PHONY: build test test-integration run db-up down vet deploy-check smoke

# Renders the deployed stack for both environments (catches compose/env typos).
deploy-check:
	for env in staging production; do \
		APP_ENV=$$env IMAGE=example/authservice:check docker compose -f deploy/compose.yml --profile bundled-db config -q || exit 1; \
	done

# Post-deploy smoke test, e.g. `make smoke URL=https://auth.example.com`.
smoke:
	deploy/smoke.sh "$(URL)"

build:
	go build -o bin/server ./cmd/server

vet:
	go vet ./...

test:
	go test ./...

# Requires a reachable Postgres (e.g. `make db-up`). Truncates users/sessions.
test-integration:
	TEST_DATABASE_URL="$(TEST_DATABASE_URL)" go test -count=1 ./...

db-up:
	docker compose up -d db

run: db-up
	DATABASE_URL="$(TEST_DATABASE_URL)" go run ./cmd/server

down:
	docker compose down
