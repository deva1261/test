-- auth-db: users table. Emails are stored normalised (trimmed, lower-cased)
-- by auth-api; the unique index on lower(email) guards against drift.
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  email         TEXT        NOT NULL CHECK (char_length(email) <= 254),
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));
