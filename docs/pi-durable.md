# Pi-durable integration

Friday uses `@earendil-works/pi-durable` 1.0.2 for agent execution, transcripts, input queues, tool execution, and recovery.
Pi's coding-agent package supplies model authentication, resource discovery, and legacy context conversion.
Friday no longer creates coding-agent sessions or maintains a runtime pool.

## Storage

`$FRIDAY_HOME/pi-durable.sqlite` contains Pi conversations, documents, submission receipts, and scheduler checkpoints.
`$FRIDAY_HOME/friday.sqlite` contains Friday configuration and projections of threads, turns, and activities.
The databases are separate because both schemas define a `documents` table.
Both databases are required to restore Friday's state.

Each Friday thread maps to one Pi conversation through `FridayThreads`.
Conversation creation and index updates commit together.
A thread's `harnessSession.resumeCursor.conversationId` points to that conversation.
The serialized `harnessSession` and `harnessTurnId` field names remain compatible with existing inspection commands.
The harness discriminator is `pi-durable`.

## Execution and recovery

`PiDurable` owns one application-scoped `Harness`.
`CodingTools` provides the coding tools, and Friday registers native `task`, `discover_platforms`, `query_platform`, and `post_platform` tools for user threads.
Title generation and adaptive routing use temporary Pi-durable harnesses with memory storage.
Friday supplies plain tool lists through `createToolRegistry`; the Effect package owns Pi's internal named registrations.
There is no separate subagent tool.

Every accepted input has a `FridayTurn` receipt and a background `friday.complete-turn` task.
The task waits for Pi's submission settlement, saves the terminal turn, and attempts publication.
Delivery failures persist a retry checkpoint with exponential backoff capped at 60 seconds.
Publication is at least once. A crash after the platform accepts a reply but before Friday records delivery can produce a duplicate reply.

Steering uses Pi's native inbox.
Each steering input has its own receipt so an input consumed by a successor run still gets a reply.
Inputs that share an answer produce one platform reply.
Tool activities are projections of committed entries and live tool slots, so terminal projection repairs missed progress updates.

Background agent results become deterministic parent submissions named `report-<child-turn-id>`.
Submission deduplication prevents recovery from starting another parent run for the same report.
Cancellation persists on the child receipt and suppresses its parent report.
Cancelling a stale turn cannot abort a later run.

Startup registers conversation extensions before scheduler recovery and blocks new thread access until recovery completes.
Platform adapters and the task dispatcher are installed before recovery starts.
Pi resumes interrupted generation and applies each tool's recorded replay policy.
Friday's task tool is replay unsafe. Its effects must not repeat after an uncertain interruption.
Discovery and query tools are replay safe. The posting tool remains replay unsafe because its idempotency cache is process-local.

## Legacy state

Structural migrations rewrite the old `pi` discriminator.
On first access, Friday imports the selected, compaction-aware model context from an existing JSONL session into the new conversation.
Import reads the original file without modifying it and commits with conversation creation.
A missing file, malformed JSON, or missing session header fails the import instead of silently starting with empty context.

Unfinished legacy turns become interrupted during startup.
Turns whose thread already has a durable conversation cursor remain eligible for recovery.
Imported JSONL history supplies model context. It does not recreate legacy scheduler checkpoints or resume legacy tool invocations.

## Resources and reload

Friday continues to discover skills, `AGENTS.md`, system prompt files, and appended prompts through Pi's resource loader.
Channel prompts include the configured identity and root users for the bound platform scope.
Background prompts do not inherit channel root-user identity text.

`/harness reload` refreshes the thread's resource registration and model configuration while preserving its durable conversation.
Reload refuses while the conversation has an active run.
Pi model and authentication files refresh locally before a conversation opens.

Resource resolution delegates to Pi's `DefaultResourceLoader` without changing its discovery or precedence rules.
The Effect package calls Pi's unmodified `buildSystemPrompt` with the same resource inputs as `AgentSession._rebuildSystemPrompt`.
A package patch exports that private builder. It changes no loader or renderer logic.

A discovered `SYSTEM.md` supplies the preamble.
Without that file, Friday's audience-specific template supplies the preamble.
When a loaded preamble exists, Friday's policy and identity template becomes a separate `friday` section.
Pi renders appended prompts, project instructions with their paths, skills, and the working directory in its original order and tags.
Skill instructions follow the conversation's actual tools: `read`, then `bash`, or no skill section when neither is available.
Hidden skills remain omitted through Pi's formatter.
Each thread registration caches its loader with Effect, and reload replaces the registration and cache.

Coding-agent JavaScript extensions are not loaded.
Existing custom tools can use `defineEffectTool` and join Friday's tool list.
See [Provide tools to Pi-durable](pi-durable-tools.md) for examples, registration, and replay rules.
The [Effect wrapper package](../packages/pi-durable-effect/README.md) owns harness scopes, cancellation bridges, resource adapters, and SQLite adaptation.

## Upstream references

- [Pi-durable README at v1.0.2](https://github.com/earendil-works/pi/blob/v1.0.2/packages/durable/README.md) describes the experimental API and durable execution model.
- [Submission implementation](https://github.com/earendil-works/pi/blob/v1.0.2/packages/durable/src/harness/submissions.ts) defines request deduplication and input settlement.
- [Tool execution](https://github.com/earendil-works/pi/blob/v1.0.2/packages/durable/src/harness/tool.ts) defines safe and unsafe replay.
- [Prompt builder](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/src/core/system-prompt.ts) defines resource tags, ordering, and skill filtering.
- [Agent session](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/src/core/agent-session.ts) supplies loader resources and active tool names to the builder.
- [Resource loader](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/src/core/resource-loader.ts) defines resource discovery and precedence.
- [Session manager](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/src/core/session-manager.ts) defines legacy branch and compaction context conversion.

Verification uses temporary SQLite databases and Pi's faux provider.
The SQLite adapter also passes Pi's 23 storage conformance cases, including atomic rollback, indexes, document reconstruction, and closed-storage rejection.
`pnpm verify` runs formatting, lint, type checks, unit tests, and integration tests.
