CREATE TABLE IF NOT EXISTS messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  provider_message_id TEXT UNIQUE,
  direction           TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  author              TEXT NOT NULL,
  body                TEXT NOT NULL,
  status              TEXT NOT NULL
                      CHECK (status IN ('received', 'sending', 'sent', 'delivered', 'failed', 'cancelled')),
  provider_updated_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON messages (conversation_id, created_at);
