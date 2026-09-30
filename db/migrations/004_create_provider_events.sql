-- Inbox/outbox for provider webhooks: a row is written before the Kafka publish,
-- and processed_at makes the consumer's apply step exactly-once.
CREATE TABLE IF NOT EXISTS provider_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_event_id TEXT NOT NULL UNIQUE,
  type              TEXT NOT NULL,
  payload           JSONB NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL,
  published_at      TIMESTAMPTZ,
  processed_at      TIMESTAMPTZ,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT
);

CREATE INDEX IF NOT EXISTS provider_events_unpublished_idx
  ON provider_events (received_at) WHERE published_at IS NULL;
