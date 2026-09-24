# auth-api

Serves the four `/api/auth/*` routes: validates payloads, enforces the signup/login
business rules, hashes and checks passwords, and issues, checks and revokes
server-side sessions. It renders no UI and owns only the `users` and `sessions`
tables in **auth-db** (PostgreSQL).

## Endpoints

| Op     | Route                     | Success | Errors |
|--------|---------------------------|---------|--------|
| OP-001 | `POST /api/auth/signup`   | `201 { user }` | `400 VALIDATION_ERROR`, `409 EMAIL_TAKEN` |
| OP-002 | `POST /api/auth/login`    | `200 { user }` + `sid` cookie | `400 VALIDATION_ERROR`, `401 INVALID_CREDENTIALS` |
| OP-003 | `POST /api/auth/logout`   | `204`, cookie cleared | none (idempotent) |
| OP-004 | `GET /api/auth/me`        | `200 { user }` | `401 UNAUTHENTICATED` |

`user` is always `{ id, name, email, createdAt }`. No password or hash field is ever returned.

### Rules

- **Signup:** `name` 1–100 chars; `email` valid, trimmed and lower-cased, unique
  (case-insensitive); `password` 8+ chars, at most 72 bytes, with at least one
  letter and one digit; `confirmPassword` must match. Unknown fields are rejected.
  Passwords are hashed with bcrypt (`BCRYPT_ROUNDS`, default 12).
- **Login:** unknown email and wrong password return the same `401` and take the
  same bcrypt time, so the endpoint cannot be used to discover which emails exist.
- **Sessions:** a 256-bit random token goes in an `HttpOnly; Secure; SameSite=Lax`
  cookie named `sid`. Only its SHA-256 hash is stored in `sessions`. Sessions expire
  after `SESSION_TTL_HOURS` (default 168). Logout revokes only the caller's session.
- All auth responses send `Cache-Control: no-store`.

Errors use one shape: `{ "error": { "code", "message", "details?" } }`.

## Running locally

```bash
cp .env.example .env
docker compose up --build        # auth-db + migrations + auth-api on :3000
```

Or without Docker for the API:

```bash
npm install
docker compose up -d auth-db
DATABASE_URL=postgres://auth:auth@localhost:5432/auth npm run migrate
DATABASE_URL=postgres://auth:auth@localhost:5432/auth COOKIE_SECURE=false npm run dev
```

## Configuration

| Variable            | Default | Notes |
|---------------------|---------|-------|
| `DATABASE_URL`      | none (required) | auth-db connection string |
| `PORT`              | `3000`  | |
| `SESSION_TTL_HOURS` | `168`   | Also sets the cookie expiry |
| `COOKIE_SECURE`     | `true`  | Set `false` only for plain-HTTP local dev |
| `BCRYPT_ROUNDS`     | `12`    | |

## Tests

```bash
npm test          # vitest + supertest against in-memory repositories
npm run typecheck
```

## Deployment

- `.github/workflows/ci.yml` runs on every PR: typecheck, tests, migrations
  against a Postgres 16 service (applied twice to check they are idempotent),
  build, and a Docker image build.
- `.github/workflows/deploy.yml` runs on push to `main`: it pushes the image to
  GHCR, migrates auth-db, triggers the rollout webhook, then polls `/healthz`.
  It needs the `AUTH_DATABASE_URL` and `AUTH_API_DEPLOY_WEBHOOK_URL` secrets and
  the `AUTH_API_URL` variable, all in the `production` environment.

Migrations are plain SQL files in `db/migrations/`. They are tracked in
`schema_migrations` and run under a Postgres advisory lock, so two deploys
running at once do not conflict.
