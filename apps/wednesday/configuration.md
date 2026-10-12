# Wednesday configuration and storage

## Runtime variables

| Variable                   | Value                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `CLERK_PUBLISHABLE_KEY`    | Clerk development publishable key, beginning with `pk_test_`                                                   |
| `CLERK_JWT_KEY`            | The development instance's PEM public key for session verification                                             |
| `WEDNESDAY_ENCRYPTION_KEY` | A base64-encoded 32-byte key for encrypting provider API keys                                                  |
| `WEDNESDAY_ORIGIN`         | Browser origin accepted by Clerk verification and authenticated HTTP requests. Default `http://localhost:3002` |
| `WEDNESDAY_PORT`           | Listening port. Default `3002`                                                                                 |
| `WEDNESDAY_HOST`           | Listening address. Default `127.0.0.1`                                                                         |
| `WEDNESDAY_DATABASE`       | SQLite path. Default `wednesday.sqlite` in the working directory                                               |

The local development configuration is `~/.config/wednesday/development.env`, with permissions `0600`. Docker Compose stores its database at `/data/wednesday.sqlite` in the `wednesday-development_data` volume.

Clerk uses the development instance of 読め. That instance already has waitlist access, required verified email, email-code sign-in, and Google disabled. Wednesday verifies signed user-session tokens with the instance's public key. Wednesday requires no Clerk secret key. Clerk controls waitlist admission through its dashboard.

Provider API keys are encrypted with AES-256-GCM before they enter SQLite. Server responses expose whether a key exists, never the key itself. Chat history remains plaintext in SQLite. The encryption key must remain stable to read saved provider keys.

## Model requests

Model discovery calls the configured base URL's `/models` endpoint. Inference uses `/chat/completions` through Fold's OpenAI-compatible adapter. Responses-only endpoints are not supported by this version.

The model list does not define a standard capability format. Wednesday supplies editable starting limits and recognizes common OpenAI reasoning model IDs. Unknown model IDs start with only an `off` mapping. The context and output limits are configuration values, not discovered capabilities.

Each model has extra request fields and a request-field object for every supported thinking level. The selected level's fields override the model's extra fields. Wednesday sets an output-token limit unless the mapping supplies `max_tokens` or `max_completion_tokens`. The model, messages, tools, and streaming controls remain application-owned.

## Persistence contracts

`Storage` owns user settings, encrypted credentials, Fold events, message projections, and OptChat state. `Migrations` owns schema upgrades. The SQLite implementations are in `SqliteStorage.ts` and `SqliteMemory.ts`; business services contain no SQL. Another database supplies both interfaces and adapter-specific migrations.

One Clerk user ID owns one permanent conversation. Every storage query includes the owner ID. Different users can run concurrently, while one user's turns run sequentially. Each accepted request has a client request ID. Receipts remain in a bounded in-memory cache for up to 24 hours. Reusing an ID with identical content adds no second submission while its receipt remains available; reusing it with different content fails. Receipts are lost on restart.

Fold events and their message projections are written in one transaction. Consumed user messages retain their request IDs for reconciliation across tabs and reconnects. Original chat messages and the binary summary tree persist independently of browser connections. OptChat freezes earlier memory for each run and retains the current run's messages and tools in the model's request tail. The agent exposes only `zoom` and `date`, and Fold's ordinary auto-compaction is disabled.

Memory jobs are queued atomically with each appended message and processed in the background, with at most eight compactions per user. Successful nodes are immutable; completing two siblings queues their parent. Failed jobs retry on a later message, and unfinished jobs recover after restart. The next turn waits for earlier memory to settle.

The main view grows to 128,000 UTF-8 bytes, then batches toward 64,000. A separate persisted compaction view grows to 32,000 bytes and batches toward 16,000. It contains only built summaries and ends before a source message, or at the end of a merge's source range. View updates preserve Friday's binary addressing and age-based merge order.

The Provider settings include a separate Memory model. When older settings have no memory-model choice, Wednesday prefers a recognizable lightweight variant from the saved model list; an explicit empty choice uses the chat model. Compactions use the memory model's off mapping, a 512-byte ruler, measured byte feedback, and up to five attempts. The shortest nonempty response is retained.

Each turn starts a fresh Fold session. Only the frozen view and current turn enter its model requests. Text longer than 30,000 Unicode characters is preserved as adjacent message pages; tool echoes retain their first and last 15,000 characters. The browser receives complete messages. Text and reasoning deltas are not sent to the browser, and reasoning is not added to the durable log or memory. SQLite commits use synchronous FULL.

Active turns, pending steering, busy state, Stop state, and request receipts live in memory. Restarting the server loses them. Saved messages, settings, and OptChat memory remain available. Migration 3 removes the old submission table and adds request IDs to saved messages.

Steering targets the current turn ID and is consumed one message at a time at Fold's next model step after a tool call. Unconsumed steering is discarded when the turn finishes or stops. Wednesday never starts another turn from unused steering. The browser marks those bubbles as "Not used"; Edit restores their text to the composer for an explicit new send.

Commands use authenticated Effect HttpApi endpoints. Each tab opens its own SSE connection. Status events include the current turn ID and pending messages, and saved settings are broadcast to every connected tab. Unsaved settings edits remain local.

Each SSE stream has an authorization lease. The browser renews that lease every 20 seconds with a valid Clerk token from the SDK cache, which refreshes tokens as needed. The server allows 15 seconds beyond token expiry before closing an unrenewed connection and sends a heartbeat every 10 seconds. Renewal must authenticate as the stream's owner.

A turn continues when a browser disconnects. On reconnect, the browser sends the largest saved message ID it has received. The snapshot includes only later messages, plus current settings and runtime state. The browser merges those messages into its existing timeline and reconciles pending bubbles by request ID. It follows new messages only when the reader is already at the bottom.

## Current scope

Wednesday starts with fresh history. Friday's existing application and data remain separate. This version has no history import, shared conversations, organizations, subagents, coding tools, or production Clerk configuration. The development deployment runs through Docker Compose on silicon and Tailscale HTTPS port 8446.

Frontend assets embedded in the executable use Effect HTTP compression with Brotli quality 5 or gzip. Hashed assets have immutable cache headers; HTML uses `no-cache`. Reconnecting displays a rounded status pill and preserves the timeline and draft. Sending resumes after the snapshot has synchronized.
