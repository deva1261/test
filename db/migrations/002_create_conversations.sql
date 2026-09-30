CREATE TABLE IF NOT EXISTS conversations (
  id                   TEXT PRIMARY KEY,
  title                TEXT NOT NULL,
  participant          TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
  last_message_preview TEXT,
  last_message_at      TIMESTAMPTZ,
  provider_updated_at  TIMESTAMPTZ NOT NULL,
  messages_synced_at   TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_updated_at_idx ON conversations (updated_at DESC);
CREATE INDEX IF NOT EXISTS conversations_status_idx ON conversations (status);
