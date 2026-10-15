TEST_DATABASE_URL ?= postgres://auth:auth@localhost:5433/auth?sslmode=disable

.PHONY: build test test-integration run db-up down vet

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
