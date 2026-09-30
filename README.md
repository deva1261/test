# board-api

Backend for the communication board, plus the board UI it serves at `/`. It owns the Sprintle/Twilio connect/disconnect
lifecycle, the conversation/message cache in **board-db** (PostgreSQL), conversation
status changes, search/filter, every call out to Sprintle/Twilio, and the
webhook → Kafka → cache pipeline. It is the only component that holds provider
credentials (encrypted at rest with AES-256-GCM).

Depends on: `CMP-001` communication-board-ui, `CMP-003` sprintle-twilio-api,
`CMP-005` board-db, `CMP-006` conversation-events-kafka.

## Endpoints

| Op     | Route                                    | Success | Errors |
|--------|------------------------------------------|---------|--------|
| OP-001 | `POST /integrations/connect`             | `201 { integration }` | `400 VALIDATION_ERROR`, `422 INVALID_PROVIDER_CREDENTIALS`, `502 PROVIDER_ERROR` |
| OP-002 | `POST /integrations/disconnect`          | `200 { integration, cancelledSends }` | none (idempotent) |
| OP-003 | `GET /integrations/status`               | `200 { integration }` | none |
| OP-004 | `GET /conversations`                     | `200 { conversations, meta }` | `400 VALIDATION_ERROR` |
| OP-005 | `GET /conversations/{id}/messages`       | `200 { messages, meta }` | `404 CONVERSATION_NOT_FOUND` |
| OP-006 | `POST /conversations/{id}/messages`      | `201 { message }` | `400`, `404`, `409 INTEGRATION_NOT_CONNECTED`, `409 SEND_CANCELLED`, `502 PROVIDER_ERROR` |
| OP-007 | `PATCH /conversations/{id}/status`       | `200 { conversation }` | `400`, `404`, `409 INVALID_STATUS_TRANSITION` |
| OP-008 | `POST /webhooks/sprintle-twilio/events`  | `202 { eventId }` (`200` on a duplicate) | `400`, `401 INVALID_SIGNATURE`, `503 EVENT_PUBLISH_FAILED` |
| OP-009 | `POST /internal/events/{eventId}/process`| `200 { eventId, outcome }` | `401 UNAUTHENTICATED`, `404 EVENT_NOT_FOUND` |
| —      | `GET /conversations/stream`              | `text/event-stream` of `change` events | none |

`message` is `{ id, conversationId, providerMessageId, direction, author, recipient, body, status, createdAt, updatedAt }`:
`author` is the sender and `recipient` the receiver. For inbound messages the recipient is the agent side
(`Agent` unless the provider names one); for outbound messages it is the conversation participant.

Errors use one shape: `{ "error": { "code", "message", "details?" } }`.

### Behaviour

- **Connect** verifies the credentials against Sprintle/Twilio before storing them,
  and replaces any active integration. The status endpoint never returns the token;
  the account SID is masked (`AC••••••1234`).
- **Disconnect** marks the integration disconnected and aborts every message send in
  flight; those sends return `409 SEND_CANCELLED` and the message is stored as
  `cancelled`. The cache is kept, so the board still shows history.
- **Fetch-through.** `GET /conversations` and `GET /conversations/{id}/messages` read
  from board-db. If the cache is older than `CACHE_TTL_SECONDS`, they first pull
  changes from the provider (conversations use `updatedSince`). If that call fails,
  cached data is served with `meta.stale: true` and the integration shows
  `health: degraded`. Concurrent list requests share one provider call.
- **List filters:** `status` (`open` | `in_progress` | `resolved`), `q` (matches title,
  participant or last message preview, case-insensitive), `since` (ISO timestamp;
  rows changed after it), `limit` (1–200, default 50). Newest activity first.
- **Status transitions:** `open → in_progress | resolved`, `in_progress → open | resolved`,
  `resolved → open`. Setting the current status again is a no-op. Board status lives
  only in board-db; provider updates never overwrite it.
- **Send** writes the message as `sending`, then calls the provider with the row id as
  `clientRef` (and `Idempotency-Key`), so the webhook for our own message updates that
  row instead of creating a duplicate.

### Webhook → Kafka → cache

1. `POST /webhooks/sprintle-twilio/events` checks `X-Sprintle-Signature`
   (`sha256=<hex HMAC of the raw body>`), records the event in `provider_events`
   (deduplicated on the provider event id), then publishes `{ eventId }` to the
   `conversation-events` topic, keyed by conversation id so each conversation's events
   stay in order.
2. If Kafka is down the webhook returns `503` so the provider retries. The worker also
   relays any event still unpublished after 30 seconds (outbox pattern).
3. The worker (`src/worker.ts`) consumes the topic and applies each event inside one
   transaction that locks the event row, updates the cache, and sets `processed_at`.
   Redeliveries and concurrent deliveries are no-ops. Updates older than the cached
   copy (by provider `updatedAt`) are ignored.
4. `POST /internal/events/{eventId}/process` runs the same apply step over HTTP, for
   replays and operations. It requires `Authorization: Bearer $INTERNAL_API_TOKEN`.

Handled event types: `conversation.created`, `conversation.updated`, `message.created`,
`message.updated`. Other types are acknowledged and ignored.

### Live updates

`GET /conversations/stream` is a Server-Sent Events stream. Every cache write sends a
`pg_notify('board_changes', …)`: a new or updated conversation, a new message, a status
change, or an integration change. Inside the consumer's transaction, Postgres only
delivers the notification once the transaction commits. Each API replica `LISTEN`s and
forwards the change to its open streams as
`{ type: 'conversation.changed' | 'message.changed' | 'integration.changed', … }`.
A conversation that arrives by webhook therefore appears on every open board without a
page refresh. If the stream drops, the UI falls back to polling every 15 seconds.

## Board UI (`public/`)

Plain ES modules with no build step, served by board-api at `/`:

- **Board and list views.** Open / In Progress / Resolved columns, or a list. Switching
  views keeps the selected conversation, and each conversation keeps its own reply draft.
- **Connection status badge.** Green *Connected*, grey *Disconnected* / *Not connected*,
  red *Connection error* with the provider's error. It updates live from
  `integration.changed`.
- **Search and status filter.** A search with no matches shows a "No matching
  conversations" empty state with a *Clear filters* button, not an error.
- **Loading, empty and error states.** A loading indicator shows while data is fetched,
  and an empty state when there are no conversations. When a call fails, a clear error
  banner appears with *Retry*, and the board keeps showing the last loaded data. When the
  provider is down, a notice says the data may be out of date.
- **Messages.** Each message shows sender → receiver, content, timestamp and a status
  (Received / Sending / Sent / Delivered / Failed / Cancelled).
- **Sending.** A failed send keeps the draft in the composer and says why.

The page is served with `Content-Security-Policy: connect-src 'self'`, so the browser
can only reach board-api. The UI's API client (`public/js/api.js`) accepts only relative,
same-origin paths.

### Request flow (REQ-009)

```
Board UI (browser) ──same-origin only──▶ board-api ──HTTPS, Basic auth──▶ Sprintle/Twilio API ──▶ Communication Service
        ▲                                   │  ▲                                  │
        └──── SSE /conversations/stream ────┘  └── signed webhook → Kafka → worker ┘
```

The UI never holds provider credentials or calls the provider. Only board-api does, in
`src/provider/httpClient.ts`. Sprintle/Twilio's link to the underlying Communication
Service is on the provider's side of the `CMP-003` contract, so this repo can't test it.

## Requirement coverage

| Requirement | Where | Tests |
|-------------|-------|-------|
| REQ-002 board view, selection kept across views, new conversations appear live | `public/js/view.js`, `public/js/controller.js`, `src/routes/stream.ts`, `src/events/pgListener.ts` | `tests/ui/board.dom.test.ts`, `tests/realtime.test.ts` |
| REQ-003 sender, receiver, content, timestamp, status per message | `db/migrations/005_add_message_recipient.sql`, `src/domain.ts`, `public/js/view.js` | `tests/realtime.test.ts`, `tests/ui/board.dom.test.ts` |
| REQ-006 search and filters, empty state for no results | `src/repositories/postgres.ts`, `public/js/state.js` | `tests/conversations.test.ts`, `tests/realtime.test.ts`, `tests/ui/*.test.ts` |
| REQ-007 connected / disconnected / error indicator | `src/services/integrationService.ts`, `public/js/state.js` | `tests/integrations.test.ts`, `tests/ui/state.test.ts`, `tests/ui/board.dom.test.ts` |
| REQ-008 loading, empty, clear errors without breaking the board | `src/services/conversationService.ts`, `public/js/controller.js`, `public/js/view.js` | `tests/realtime.test.ts`, `tests/ui/board.dom.test.ts` |
| REQ-009 UI → board-api → Sprintle/Twilio only | `src/app.ts` (CSP), `public/js/api.js`, `src/provider/httpClient.ts` | `tests/realtime.test.ts`, `tests/ui/api.test.ts`, `tests/unit.test.ts` |

## Running locally

```bash
cp .env.example .env
export CREDENTIALS_ENCRYPTION_KEY=$(openssl rand -base64 32)
docker compose up --build        # board-db, Kafka, migrations, board-api on :3000, board-worker
open http://localhost:3000       # the board UI
```

Or without Docker for the API:

```bash
npm install
docker compose up -d board-db kafka
DATABASE_URL=postgres://board:board@localhost:5433/board npm run migrate
npm run dev          # HTTP API
npm run dev:worker   # Kafka consumer + outbox relay
```

## Configuration

| Variable                     | Default | Notes |
|------------------------------|---------|-------|
| `DATABASE_URL`               | none (required) | board-db connection string |
| `KAFKA_BROKERS`              | none (required) | Comma-separated |
| `KAFKA_TOPIC`                | `conversation-events` | |
| `KAFKA_GROUP_ID`             | `board-api-events` | Consumer group for the worker |
| `KAFKA_CLIENT_ID`            | `board-api` | |
| `SPRINTLE_API_BASE_URL`      | none (required) | |
| `SPRINTLE_WEBHOOK_SECRET`    | none (required) | HMAC secret for webhook signatures |
| `PROVIDER_TIMEOUT_MS`        | `10000` | Per provider request |
| `CREDENTIALS_ENCRYPTION_KEY` | none (required) | 32 bytes, base64 |
| `INTERNAL_API_TOKEN`         | none (required) | Bearer token for `/internal/*` |
| `CACHE_TTL_SECONDS`          | `30` | Fetch-through freshness window |
| `PORT`                       | `3000` | |

## Tests

```bash
npm test          # API tests (vitest + supertest, in-memory repos, fake provider) and UI tests (jsdom)
npm run typecheck
```

CI (`.github/workflows/ci.yml`) also applies the migrations against Postgres 16 twice
to check they are idempotent, builds, and builds the Docker image.
