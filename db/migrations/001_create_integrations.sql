CREATE TABLE IF NOT EXISTS integrations (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_sid            TEXT NOT NULL,
  credentials_ciphertext TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('connected', 'disconnected')),
  connected_at           TIMESTAMPTZ NOT NULL,
  disconnected_at        TIMESTAMPTZ,
  last_sync_at           TIMESTAMPTZ,
  last_error             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one active integration at a time.
CREATE UNIQUE INDEX IF NOT EXISTS integrations_one_connected
  ON integrations ((true)) WHERE status = 'connected';

CREATE INDEX IF NOT EXISTS integrations_created_at_idx ON integrations (created_at DESC);
