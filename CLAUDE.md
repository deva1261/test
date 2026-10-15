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
- `internal/auth/` — auth-api (CMP-002): handlers, `requireSession` middleware, bcrypt/token helpers, minimal `/login` and `/dashboard` HTML pages (stand-in for auth-frontend).

## Endpoints
- `POST /api/auth/signup` — JSON `{name,email,password,confirm_password?}` → 201 User | 400 | 409 duplicate email.
- `POST /api/auth/login` — JSON → 200 Session + cookie | 401. Form-encoded (browser) → 303 to `/dashboard` (or `/login?error=1`).
- `GET /api/auth/me` — 200 User | 401. `POST /api/auth/logout` — deletes session row, expires cookie → 200 (form: 303 `/login`) | 401.
- `GET /login`, `GET /dashboard` (protected, 401 without session), `GET /healthz`.

## Conventions
- Emails are trimmed + lowercased before storing/lookup; the unique index is on `email`.
- Passwords: 8–72 bytes, bcrypt cost from `BCRYPT_COST` (default 12), never below 10 (`MinBcryptCost`).
- Session token: 32 random bytes, base64url, sent as cookie `session` (HttpOnly, Secure, SameSite=Lax, Path=/) or `Authorization: Bearer`. Only its SHA-256 hex is stored in `sessions.token_hash`.
- `password_hash` is never serialised (`json:"-"`) even though the OpenAPI schema lists it.
- JSON errors are `{"error": "..."}`.
- New schema changes: add a new `internal/db/migrations/000N_*.sql`; never edit applied ones.

## Run / test
- Env: see `.env.example` (`DATABASE_URL` required; `ADDR`, `BCRYPT_COST`, `SESSION_TTL`, `COOKIE_SECURE`).
- `make test` — unit tests (no DB needed; Postgres tests skip).
- `make db-up && make test-integration` — also runs Postgres store tests via `TEST_DATABASE_URL` (they TRUNCATE users/sessions — use a dedicated DB).
- `make run` or `docker compose up --build` (API on 127.0.0.1:8080, Postgres on 127.0.0.1:5433).
- CI: `.github/workflows/ci.yml` (vet, build, tests with a Postgres service, docker build).
