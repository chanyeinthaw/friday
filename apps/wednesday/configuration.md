# Friday configuration and storage

## Runtime variables

| Variable                         | Value                                                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLERK_PUBLISHABLE_KEY`          | Clerk development publishable key, beginning with `pk_test_`                                                                                 |
| `CLERK_JWT_KEY`                  | The development instance's PEM public key for session verification                                                                           |
| `WEDNESDAY_ENCRYPTION_KEY`       | A base64-encoded 32-byte key for encrypting provider API keys                                                                                |
| `WEDNESDAY_ORIGIN`               | Browser origin accepted by Clerk verification and authenticated HTTP requests. Default `http://localhost:3002`                               |
| `WEDNESDAY_PORT`                 | Listening port. Default `3002`                                                                                                               |
| `WEDNESDAY_HOST`                 | Listening address. Default `127.0.0.1`                                                                                                       |
| `WEDNESDAY_PI_CHATGPT_TRANSPORT` | Pi ChatGPT chat transport: `websocket` by default, or `sse`. Memory compactions use HTTP/SSE. Browser connections use SSE with either value. |
| `WEDNESDAY_AGENT_ENGINE`         | Agent engine: `pi` by default, or `fold`. Both chat turns and memory compactions use the selected engine.                                    |
| `WEDNESDAY_DATABASE`             | SQLite path. Default `wednesday.sqlite` in the working directory                                                                             |

The local development configuration is `~/.config/wednesday/development.env`, with permissions `0600`. Docker Compose stores its database at `/data/wednesday.sqlite` in the `wednesday-development_data` volume.

Clerk uses Friday's development instance. That instance already has waitlist access, required verified email, email-code sign-in, and Google disabled. Friday verifies signed user-session tokens with the instance's public key. Friday requires no Clerk secret key. Clerk controls waitlist admission through its dashboard.

Provider API keys are encrypted with AES-256-GCM before they enter SQLite. Server responses expose whether a key exists, never the key itself. Chat history remains plaintext in SQLite. The encryption key must remain stable to read saved provider keys.

## Model requests

The API key tab selects OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages. OpenAI formats discover models at the configured base URL's `/models` endpoint and use bearer authentication. Anthropic discovers models at `/v1/models`, follows pagination, and uses `x-api-key` authentication. Enter a versioned base URL such as `https://api.anthropic.com/v1`; the adapter owns the version prefix.

Chat and memory use the selected format through Fold. Responses requests use `/responses` with inline history and response storage disabled. Anthropic uses `/v1/messages`. Existing settings without a format continue using Chat Completions. Switching formats clears the draft model list so discovery supplies compatible mappings; saved settings stay active until replacement settings are complete.

The model list does not define a standard capability format. Friday supplies editable starting limits and recognizes common OpenAI and Claude reasoning model IDs. Responses uses nested reasoning effort; Claude uses thinking budgets or adaptive thinking and output effort. Unknown model IDs start with only an `off` mapping. The context and output limits are configuration values, not discovered capabilities.

Each model has extra request fields and a request-field object for every supported thinking level. The selected level's fields override the model's extra fields. Friday sets an output-token limit unless the mapping supplies `max_tokens` or `max_completion_tokens`. The model, messages, tools, and streaming controls remain application-owned.

## Persistence contracts

`Storage` owns user settings, encrypted credentials, Fold events, message projections, and OptChat state. `Migrations` owns schema upgrades. The SQLite implementations are in `SqliteStorage.ts` and `SqliteMemory.ts`; business services contain no SQL. Another database supplies both interfaces and adapter-specific migrations.

One Clerk user ID owns one permanent conversation. Every storage query includes the owner ID. Different users can run concurrently, while one user's turns run sequentially. Each accepted request has a client request ID. Receipts remain in a bounded in-memory cache for up to 24 hours. Reusing an ID with identical content adds no second submission while its receipt remains available; reusing it with different content fails. Receipts are lost on restart.

Fold events and their message projections are written in one transaction. Consumed user messages retain their request IDs for reconciliation across tabs and reconnects. Original chat messages and the binary summary tree persist independently of browser connections. OptChat freezes earlier memory for each run and retains the current run's messages and tools in the model's request tail. The chat agent exposes `zoom`, `date`, and a JustBash `bash` tool, and the selected engine's ordinary auto-compaction is disabled.

Memory jobs are queued atomically with each appended message and processed in the background, with at most eight compactions per user. New compaction requests wait while the user's chat turn is active. Successful nodes are immutable; completing two siblings queues their parent. Failed jobs retry on a later message, and unfinished jobs recover after restart. The next turn waits for earlier memory to settle.

The main view grows to 128,000 UTF-8 bytes, then batches toward 64,000. A separate persisted compaction view grows to 32,000 bytes and batches toward 16,000. It contains only built summaries and ends before a source message, or at the end of a merge's source range. View updates preserve Friday's binary addressing and age-based merge order.

The Provider settings include a separate Memory model. When older settings have no memory-model choice, Friday prefers a recognizable lightweight variant from the saved model list; an explicit empty choice uses the chat model. Compactions use the memory model's selected thinking mapping, a 512-byte ruler, measured byte feedback, and up to five attempts. The shortest nonempty response is retained.

Chat turns and memory compactions use separate system prompts, sharing only the memory-view format. The turn prompt defines Friday's identity, memory tools, and steering behavior. The compaction prompt defines compression priorities and the 512-byte limit.

Each turn starts a fresh in-memory agent session. Pi coding-agent SDK is the default; Fold remains available through the same Effect service. Pi sessions load no filesystem tools, context files, skills, or prompt templates, and write no Pi session or credential files. Only the frozen view and current turn enter its model requests. Text longer than 30,000 Unicode characters is preserved as adjacent message pages; tool echoes retain their first and last 15,000 characters. The chat model adapter observes text deltas and broadcasts completed Markdown prefixes over SSE. Unfinished paragraphs, tables, lists, and code fences remain hidden until their block ends. The active prefix lives in memory and appears in reconnect snapshots. A completed agent message replaces its streamed bubble. Reasoning is not sent to the browser or added to the durable log or memory. SQLite commits use synchronous FULL.

Active turns, pending steering, busy state, Stop state, and request receipts live in memory. Restarting the server loses them. Saved messages, settings, and OptChat memory remain available. Migration 3 removes the old submission table and adds request IDs to saved messages.

Steering targets the current turn ID. The Pi adapter passes messages directly to native `session.steer`, which consumes them one at a time at the next model step, including after responses without tool calls. It never calls `followUp` or starts a separate turn. The Fold adapter retains model-step delivery. Unconsumed messages show "Stopped" after Stop or "Not delivered" when the run ends. "Send again" restores their text, attachments, and reply to the composer for an explicit new send.

Commands use authenticated Effect HttpApi endpoints. Each tab opens its own SSE connection. Status events include the current turn ID and pending messages, and saved settings are broadcast to every connected tab. Unsaved settings edits remain local.

Each SSE stream has an authorization lease. The browser renews that lease every 20 seconds with a valid Clerk token from the SDK cache, which refreshes tokens as needed. The server allows 15 seconds beyond token expiry before closing an unrenewed connection and sends a heartbeat every 10 seconds. Renewal must authenticate as the stream's owner.

Initial snapshots contain at most 250 visible user and assistant messages. The authenticated history endpoint returns earlier pages by message ID, with an indicator for remaining history. Prepending a page preserves the reader's scroll position.

A turn continues when a browser disconnects. On reconnect, the browser sends the largest saved message ID it has received. The snapshot includes only later messages, plus current settings and runtime state. The browser merges those messages into its existing timeline and reconciles pending bubbles by request ID. It follows new messages only when the reader is already at the bottom.

## Clearing chat and memory

General settings includes a confirmed **Clear chat and memory** action. Stop the current response first. Clearing stops background memory work and deletes only the signed-in user's messages, agent logs, memory views, summaries, and jobs in one transaction. Provider connections, integration keys, and preferences remain. Attachments become inaccessible immediately and enter the normal cleanup job after existing signed upload URLs expire. A persisted conversation revision resets every open tab and forces a fresh snapshot when an older tab reconnects.

## Attachments

The object adapter uses Bun's native S3 client. These environment variables configure R2 or another S3-compatible service:

| Variable                         | Value                                              |
| -------------------------------- | -------------------------------------------------- |
| `WEDNESDAY_S3_ENDPOINT`          | S3 API endpoint, including the R2 account hostname |
| `WEDNESDAY_S3_BUCKET`            | Private attachment bucket                          |
| `WEDNESDAY_S3_ACCESS_KEY_ID`     | Object-storage access key                          |
| `WEDNESDAY_S3_SECRET_ACCESS_KEY` | Object-storage secret key                          |
| `WEDNESDAY_S3_REGION`            | Region, default `auto`                             |

Bucket CORS permits `PUT`, `GET`, and `HEAD` from the app's origin, with the `Content-Type` request header. Credentials stay on the backend. Upload URLs expire after 10 minutes; authenticated download requests return signed URLs valid for 15 minutes. The bucket has no public access.

`Storage` persists attachment metadata and ownership. `AttachmentObjects` owns signing and object access. `Attachments` coordinates validation, references, and cleanup. Migration 5 adds attachment metadata and message references. Each user has a 512 MB upload allowance, including pending uploads. Each file is limited to 10 MB, with at most 10 attachments per message.

The browser reserves an upload, sends its bytes directly to a signed staging URL, and requests completion. The backend checks the size, image signature or UTF-8 text, then stores a finalized object under a separate key. A staging URL cannot overwrite a finalized object. HTML stays unchanged and downloads as an attachment.

Files move through `pending`, `ready`, `used`, and `deleting` states. Completion makes a file ready; consuming its user message marks it used in the same transaction as the saved message. Unconsumed steering, removed attachments, failed submissions, and abandoned uploads remain unused. `Attachments.markUsed` is also the reference operation for future durable filesystem saves; the current `/tmp` workspace is disposable.

A scoped Effect worker runs at startup and every 15 minutes. It claims uploads older than 24 hours, deletes unused objects, and removes their metadata. It also removes expired staging objects for used files while retaining their finalized objects. Failed deletions keep their metadata for retry. Claiming and referencing files use database transactions, so a file cannot become used after cleanup claims it. Restarts preserve this state and resume cleanup.

Images enter the current model message directly, including consumed steering. The durable log stores their file references without image bytes. Text, Markdown, and HTML remain available through lazy, user-scoped `/attachments/<id>/<name>` paths. JustBash has no network or host filesystem access; Python, JavaScript, and SQLite commands are unavailable. `/attachments` is read-only, and `/tmp` is writable for one turn. Execution, output, and workspace sizes have limits. The `just-bash/browser` export runs inside the compiled Bun binary without WASM.

## Current scope

The web app starts with fresh history. Friday's existing application and data remain separate. This version has no history import, shared conversations, organizations, subagents, coding tools, or production Clerk configuration. The development deployment runs through Docker Compose on silicon and Tailscale HTTPS port 8446.

The build splits browser assets before embedding them in the executable. Highlighting and Mermaid load only when needed. Embedded assets use Effect HTTP compression with Brotli quality 5 or gzip. Hashed assets have immutable cache headers; HTML uses `no-cache`. Reconnecting displays a rounded status pill and preserves the timeline and draft. Sending resumes after the snapshot has synchronized.

## Firecrawl web search

Settings → Integrations stores a separate Firecrawl API key for each user. Pasting the key connects automatically; leaving the field or pressing Enter also saves it. The backend validates the key with Firecrawl's credit-usage endpoint before replacing an existing key. Keys use the same AES-GCM credential service as provider keys and never appear in settings snapshots, tool results, or API responses. Migration 6 adds the integration credential table behind `Storage`.

Connected users get `web_search` in their next chat turn in either Pi or Fold. Memory compactions do not receive it. Searches use the fixed Firecrawl v2 endpoint, return up to five titles, URLs, and descriptions, and do not request page scraping. Queries are limited to 500 characters and requests time out after 30 seconds. Searches are not automatically retried because retries can spend more credits. Disconnecting removes the saved key and blocks subsequent tool calls, including calls from an existing turn; it cannot cancel a request already sent to Firecrawl.

The integration page reads the team's remaining credits, plan allowance, and billing-period dates directly from `/v2/team/credit-usage`. Plan allowance excludes coupon and pay-as-you-go credits, so the page shows it separately from the remaining balance. Unavailable usage stays unavailable rather than showing a false zero. Refresh checks the latest balance. Firecrawl does not document a credit-usage field for the team's search rate limit, so the UI links its plan rate-limit table instead of inferring a plan from its balance.

Official pricing and API details are recorded in [the Firecrawl research note](../../docs/research/firecrawl.md). The adapter and encrypted-storage lifecycle have mocked integration coverage; a real Firecrawl key is needed to verify a billable search against the hosted API.


## Chat activities

Chat shows compact activity rows based on T3 Code's work log. Consecutive tool calls share a disclosure; each step expands to show its command, search query, or memory range and a result preview. New tool calls retain their completed, failed, or stopped status after reload. Migration 7 adds this display metadata alongside the existing message projections. It leaves the agent log and memory source text unchanged.

Initial snapshots and older-history pages include up to 500 tool activities alongside their 250 visible messages. Reconnects also refresh activities within the last 500 message IDs to reconcile a tool that completed while the tab was disconnected. The client updates the existing row by ID. Tool results preview the first 4,000 characters with an ellipsis when truncated. Stop and startup recovery settle unfinished activities.

The live status changes between Thinking, the active tool, and Writing response. It reports lifecycle state and does not expose model reasoning text. Thinking and Writing response disappear when the turn ends; completed tool rows remain in the timeline. Existing tool calls from before migration 7 have no activity metadata.
