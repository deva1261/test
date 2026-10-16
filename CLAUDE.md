# Secure Authentication Service

Go HTTP service for signup / login / current user / logout, backed by PostgreSQL
with stateful, database-stored sessions (no JWT).

## Stack
- Go 1.26 (stdlib `net/http` with method+path `ServeMux` patterns, `log/slog`)
- PostgreSQL 16 via `github.com/jackc/pgx/v5` (`pgxpool`)
- `golang.org/x/crypto/bcrypt` for passwords, `github.com/google/uuid` for ids
- Redis is listed in the project stack but is not used: sessions live in Postgres (design decision DEC-001).

## Layout
- `cmd/server/` — entrypoint; reads env, runs migrations, serves HTTP.
- `internal/db/` — `migrations/NNNN_*.sql` (embedded, forward-only, applied in lexical order, tracked in `schema_migrations`) and `Migrate()`.
- `internal/store/` — auth-db (CMP-003): `Store` interface, `Postgres` impl, `Memory` impl (same constraint semantics, for tests). Constraint violations map to `ErrEmailTaken`, `ErrTokenTaken`, `ErrUserMissing`; missing rows to `ErrNotFound`.
- `internal/config/` — env loading + validation (`Load`/`LoadFrom`); `KEY_FILE` secret files; `Config.LogValue` redacts the DB password.
- `deploy/` — deployed stack: `compose.yml` (api + optional `bundled-db` profile), `staging.env`/`production.env` (non-secret settings), `secrets/` (git-ignored secret files), `deploy.sh` (on-host rollout), `ci-deploy.sh` (CI → host over SSH), `smoke.sh` (post-deploy checks).
- `internal/auth/` — auth-api (CMP-002): handlers, `requireSession` middleware, bcrypt/token helpers, minimal `/login` and `/dashboard` HTML pages (stand-in for auth-frontend).

## Endpoints
- `POST /api/auth/signup` — JSON `{name,email,password,confirm_password?}` → 201 User | 400 | 409 duplicate email.
- `POST /api/auth/login` — JSON → 200 Session + cookie | 401. Form-encoded (browser) → 303 to `/dashboard` (or `/login?error=1`).
- `GET /api/auth/me` — 200 User | 401. `POST /api/auth/logout` — deletes session row, expires cookie → 200 (form: 303 `/login`) | 401.
- `GET /login`, `GET /dashboard` (protected, 401 without session), `GET /healthz` (liveness), `GET /readyz` (DB ping, 503 if down; wired in `cmd/server`).
- `server -healthcheck` probes local `/healthz` (the distroless image has no curl).

## Conventions
- Emails are trimmed + lowercased before storing/lookup; the unique index is on `email`.
- Passwords: 8–72 bytes, bcrypt cost from `BCRYPT_COST` (default 12), never below 10 (`MinBcryptCost`).
- Session token: 32 random bytes, base64url, sent as cookie `session` (HttpOnly, Secure, SameSite=Lax, Path=/) or `Authorization: Bearer`. Only its SHA-256 hex is stored in `sessions.token_hash`.
- `password_hash` is never serialised (`json:"-"`) even though the OpenAPI schema lists it.
- JSON errors are `{"error": "..."}`.
- New schema changes: add a new `internal/db/migrations/000N_*.sql`; never edit applied ones.

- Config: every new setting goes through `internal/config` (parse in `LoadFrom`, check in `Validate`, add to `.env.example` and `deploy/*.env`). Secrets accept `KEY` or `KEY_FILE`, never both, and are never logged.
- `APP_ENV=staging|production` enforces `COOKIE_SECURE=true`, `BCRYPT_COST>=12` and TLS to Postgres (`sslmode=require` or stricter) unless `DB_ALLOW_INSECURE=true` (private-network DB only).
- Session tokens are opaque random values looked up by hash, so there is no cookie-signing key to manage.

## Run / test
- Env: see `.env.example` (`DATABASE_URL` or `DATABASE_URL_FILE` required; `APP_ENV`, `ADDR`, `BCRYPT_COST`, `SESSION_TTL`, `COOKIE_SECURE`, `SHUTDOWN_TIMEOUT`, `DB_ALLOW_INSECURE`).
- `make test` — unit tests (no DB needed; Postgres tests skip).
- `make db-up && make test-integration` — also runs Postgres store tests via `TEST_DATABASE_URL` (they TRUNCATE users/sessions — use a dedicated DB).
- `make run` or `docker compose up --build` (API on 127.0.0.1:8080, Postgres on 127.0.0.1:5433).
- `make deploy-check` renders `deploy/compose.yml` for both environments; `make smoke URL=...` runs `deploy/smoke.sh`.
- Local rehearsal of a deploy: put `database_url`/`postgres_password` in `deploy/secrets/`, then `SKIP_PULL=1 APP_ENV=staging IMAGE=<local tag> COMPOSE_PROFILES=bundled-db PUBLISH_ADDR=127.0.0.1:18080 deploy/deploy.sh`.

## CI/CD (`.github/workflows/ci.yml`)
- `test` (every push/PR): gofmt, vet, build, `go test -race` against a Postgres service, shellcheck `deploy/*.sh`, `make deploy-check`.
- `image`: builds the Docker image; on push it goes to `ghcr.io/<owner>/<repo>` (tags `sha-*`, branch, semver) and is deployed **by digest**.
- `deploy-staging`: push to `main` or a `v*` tag. `deploy-production`: `v*` tags only, after staging; add required reviewers to the `production` GitHub environment.
- Per GitHub environment: secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DATABASE_URL`, optional `POSTGRES_PASSWORD` (turns on bundled Postgres), optional `DEPLOY_KNOWN_HOSTS`; vars `PUBLIC_URL` (smoke test), `DEPLOY_PATH`, `DEPLOY_PORT`.
- On the host, secret files are mode 644 inside a 0700 `secrets/` dir. Compose bind-mounts them with host ownership, and the image runs as uid 65532.
