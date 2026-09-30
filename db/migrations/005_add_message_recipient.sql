-- REQ-003: every message records who received it, not only who sent it.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS recipient TEXT;

UPDATE messages m
SET recipient = CASE WHEN m.direction = 'outbound' THEN c.participant ELSE 'Agent' END
FROM conversations c
WHERE c.id = m.conversation_id AND m.recipient IS NULL;

ALTER TABLE messages ALTER COLUMN recipient SET NOT NULL;
