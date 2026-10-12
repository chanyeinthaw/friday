# Replacing Pi with Fold in Friday

Investigated on 2026-10-12 against Fold commit `e3a8aeb3ed62398cd6221c9bd13ba3d3cf88b567` and effect-channels commit `b2e25f40620e98c67b9aa11d67203722adc9bc9f`.

Friday can remove Pi completely using Fold, but Fold does not replace every guarantee that Friday currently gets from Pi-durable. The channel migration is a separate decision. effect-channels supports Slack, GitHub, and Linear, but has no Discord package and explicitly excludes Slack Socket Mode.

## Fold can replace agent execution

Fold provides an Effect-native agent loop, model bindings, tool execution, event streaming, steering, cancellation, subagents, skills, and replaceable session storage. `fold-agent` adds coding tools. Friday can supply its own task and platform tools with `defineTool`, while retaining its existing thread and task ownership rules. Sources: [Fold README][fold-readme], [session API][fold-session], and [tool definitions][fold-tools].

The isomorphic core does not require Cloudflare. Friday can continue using Bun and local worktrees. Its host supplies a persistent event log through `eventLogSource`; Fold's own Cloudflare example implements that contract over SQLite. I found no packaged Bun SQLite event-log backend, so Friday needs an adapter. Sources: [event-log descriptor][fold-log] and [SQLite example][fold-sqlite].

## Session recovery differs from Pi-durable

`resumeSession` reconstructs a session from its log. It does not restore Pi's submission receipts or durable scheduler checkpoints. Fold's example host detects unfinished user input and sends a bounded continuation message after restart. A recorded tool call without a matching result receives a synthetic failure in the model request. The model must inspect the external state before deciding whether to retry the operation. Sources: [resume implementation][fold-session], [example recovery][fold-recovery], and [request builder][fold-request].

Friday currently relies on durable input deduplication, settlement receipts, background completion tasks, publication retries, child-report deduplication, and explicit safe or unsafe tool replay. Those responsibilities need a replacement before deleting Pi-durable. Fold's log recovery alone does not establish equivalent behavior. See [Friday's Pi-durable contract](../pi-durable.md).

The critical migration checks are a crash during a posting or task tool, a restart after accepting input, cancellation of an old turn, and a restart between publishing a reply and recording delivery. Tool side effects can remain uncertain after a crash under either design; the replacement must preserve Friday's documented policy rather than silently re-run them.

## OptChat can stay, with a new integration

Fold has `preRequest` hooks that replace the outgoing `Prompt` without changing the event log. Auto-compaction can be disabled. These are suitable integration points for Friday's memory view. Sources: [hook schema][fold-hooks] and [agent definition][fold-agent-definition].

OptChat itself remains Friday-owned. Its Pi-specific transcript conversion, run-view checkpoints, compactor inference, tool declarations, and raw provider payload cache hooks need porting. A prompt hook does not prove that the serialized provider payload retains the same cache prefix. The port must verify stable system and tool prefixes, frozen memory views across tool steps and restarts, previous-turn summary settlement, and coordinated main-agent and compactor cache writes. Sources: [OptChat design](../optchat-memory.md), [current integration](../../apps/friday/src/optchat/OptChatHarness.ts), and [cache implementation](../../apps/friday/src/optchat/OptChatCache.ts).

Fold supports custom Effect `LanguageModel` bindings, so a provider wrapper can handle the parts that need more than prompt replacement. Source: [model descriptor][fold-model].

## Full Pi removal includes providers and resources

Fold includes Codex, OpenCode, and xAI authentication packages and OpenAI model support. Credentials and configuration are Fold-specific. Pi's catalog, `models.json`, authentication refresh, and resource discovery do not migrate automatically. Sources: [Fold package overview][fold-readme] and [Friday model catalog](../../apps/friday/src/harness/pi/PiModelCatalog.ts).

Fold's public `openaiModel` uses Responses. A Chat Completions client exists in `effect-ai-openai-compat`, but Friday's arbitrary OpenAI-compatible providers need explicit custom model wiring. This matters for existing OptChat providers. Sources: [provider models][fold-providers], [Responses client][fold-responses], and [Chat Completions client][fold-completions].

Fold has skills and explicit system-prompt blocks. Reproducing Friday's current Pi `AGENTS.md`, `SYSTEM.md`, appended-prompt discovery, and precedence is additional work. Existing Pi conversations also need a history importer. Unfinished Pi scheduler state cannot be treated as ordinary transcript data. See [Friday resources and legacy migration](../pi-durable.md).

## effect-channels does not cover Friday's transports

The Slack package accepts signed Events API webhooks and provides mentions, subscribed threads, direct messages, files, streaming, status, and Stop events. Its README explicitly excludes Socket Mode, slash commands, interactivity, and OAuth redirects. Friday currently uses Socket Mode, so adopting this package requires either a public webhook transport or a custom Socket Mode integration. Sources: [Slack package][channels-slack] and [Friday Slack configuration](../slack-configuration.md).

The repository lists Slack, GitHub, and Linear providers, with no Discord provider. Friday needs to retain its current Discord integration or implement a provider that preserves gateway ingestion, commands, thread routing, access rules, and multiple connections. Sources: [Channels packages][channels-readme] and [Friday Discord configuration](../discord-configuration.md).

Channels persists events before callbacks, batches mailbox input, retries leased work, and can hand execution to a remote worker. Saved output has separate retries, so a platform outage does not require replaying agent work. These capabilities fit GitHub and Linear background work particularly well. Sources: [Channels lifecycle][channels-lifecycle] and [delivery context][channels-context].

Mailbox batching is not live agent steering. An active or handed-off delivery holds its mailbox until settlement. Friday needs an explicit path for steering and urgent cancellation, including Slack Stop, instead of assuming every new event reaches a running Fold session immediately. Sources: [mailbox processing][channels-processing], [delivery lifecycle][channels-lifecycle], and [Slack event processing][channels-slack-events].

Persistent storage options include Postgres, Redis, and Cloudflare Durable Objects. The SQL package is Postgres-specific, including `FOR UPDATE SKIP LOCKED` and Postgres casts. It cannot use Friday's SQLite client unchanged. Keeping local SQLite requires implementing the Channels storage contracts. Sources: [SQL package][channels-sql], [SQL delivery slots][channels-sql-slots], and [storage contract][channels-storage].

## The Cloudflare deployment is optional

The announcement combines Fold, Channels, Alchemy, and Cloudflare Computer. Its filesystem and container workflow is example infrastructure, not a prerequisite for adopting the agent loop. At the inspected revision, the Channels example synchronizes changed files before and after container commands and starts the container after the first clone. That implementation differs from the announcement's description of starting a FUSE-mounted container only when needed. Source: [example deployment][channels-example].

Moving Friday to Workers would also change its local worktrees, command execution, filesystem assumptions, and persistent-service deployment. That is a separate migration.

## Recommendation

I would evaluate Fold as the replacement for Pi first, keeping Friday's current Discord and Slack adapters. That gives Friday an Effect-native agent runtime without coupling the decision to a transport and infrastructure rewrite.

The first proof should run one persistent thread with coding tools, an OpenAI-compatible provider, and OptChat on Bun SQLite. It must survive crashes and preserve the cache prefix. Then replace receipts, completion scheduling, publication retries, resource loading, and history migration before removing all Pi dependencies.

I would adopt effect-channels separately for GitHub or Linear events. For existing Discord and Socket Mode Slack, it currently adds custom integration work rather than eliminating it.

Both upstream repositories target stable Effect `4.0.0`; Friday uses `4.0.0-rc.109`. An Effect upgrade and API compatibility check are part of either adoption. Registry queries on the investigation date returned `@humanlayer/fold-agent` `0.1.33` and `@humanlayer/channels-slack` `0.1.0`, despite source workspace manifests using private placeholder versions. No runtime prototype or migration was performed. Sources: [Fold manifest][fold-manifest], [Channels manifest][channels-manifest], and [Friday manifest](../../apps/friday/package.json).

[fold-readme]: https://github.com/humanlayer/fold/blob/e3a8aeb3ed62398cd6221c9bd13ba3d3cf88b567/README.md
[fold-session]: https://github.com/humanlayer/fold/blob/e3a8aeb3ed62398cd6221c9bd13ba3d3cf88b567/packages/fold-core/src/Api/StartSession.ts
[fold-tools]: https://github.com/humanlayer/fold/blob/e3a8aeb3ed62398cd6221c9bd13ba3d3cf88b567/packages/fold-core/src/Api/ToolDefinition.ts
[fold-log]: https://github.com/humanlayer/fold/blob/e3a8aeb3ed62398cd6221c9bd13ba3d3cf88b567/packages/fold-core/src/Api/EventLogDescriptor.ts
[fold-sqlite]: https://github.com/humanlayer/fold/blob/e3a8aeb3ed62398cd6221c9bd13ba3d3cf88b567/examples/alchemy-cloudflare/src/DurableObjectEventLog.ts
[fold-recovery]: https://github.com/humanlayer/fold/blob/e3a8aeb3ed62398cd6221c9bd13ba3d3cf88b567/examples/alchemy-cloudflare/src/ChatSession.ts
[fold-request]: https://github.com/humanlayer/fold/blob/e3a8aeb3ed62398cd6221c9bd13ba3d3cf88b567/packages/fold-core/src/Model/RequestBuilder.ts
[fold-hooks]: https://github.com/humanlayer/fold/blob/e3a8aeb3ed62398cd6221c9bd13ba3d3cf88b567/packages/fold-core/src/HookRunner/Schema.ts
[fold-agent-definition]: https://github.com/humanlayer/fold/blob/e3a8aeb3ed62398cd6221c9bd13ba3d3cf88b567/packages/fold-core/src/Api/AgentDefinition.ts
[fold-model]: https://github.com/humanlayer/fold/blob/e3a8aeb3ed62398cd6221c9bd13ba3d3cf88b567/packages/fold-core/src/Api/ModelDescriptor.ts
[fold-providers]: https://github.com/humanlayer/fold/blob/e3a8aeb3ed62398cd6221c9bd13ba3d3cf88b567/packages/fold-core/src/Api/ProviderModels.ts
[fold-responses]: https://github.com/humanlayer/fold/blob/e3a8aeb3ed62398cd6221c9bd13ba3d3cf88b567/packages/effect-ai-openai/src/OpenAiClient.ts
[fold-completions]: https://github.com/humanlayer/fold/blob/e3a8aeb3ed62398cd6221c9bd13ba3d3cf88b567/packages/effect-ai-openai-compat/src/OpenAiClient.ts
[fold-manifest]: https://github.com/humanlayer/fold/blob/e3a8aeb3ed62398cd6221c9bd13ba3d3cf88b567/package.json
[channels-readme]: https://github.com/humanlayer/effect-channels/blob/b2e25f40620e98c67b9aa11d67203722adc9bc9f/README.md
[channels-slack]: https://github.com/humanlayer/effect-channels/blob/b2e25f40620e98c67b9aa11d67203722adc9bc9f/packages/slack/README.md
[channels-lifecycle]: https://github.com/humanlayer/effect-channels/blob/b2e25f40620e98c67b9aa11d67203722adc9bc9f/packages/delivery/src/DeliveryLifecycle.ts
[channels-context]: https://github.com/humanlayer/effect-channels/blob/b2e25f40620e98c67b9aa11d67203722adc9bc9f/packages/delivery/src/DeliveryContext.ts
[channels-processing]: https://github.com/humanlayer/effect-channels/blob/b2e25f40620e98c67b9aa11d67203722adc9bc9f/packages/delivery/src/MailboxProcessing.ts
[channels-slack-events]: https://github.com/humanlayer/effect-channels/blob/b2e25f40620e98c67b9aa11d67203722adc9bc9f/packages/slack/src/SlackEventProcessor.ts
[channels-sql]: https://github.com/humanlayer/effect-channels/blob/b2e25f40620e98c67b9aa11d67203722adc9bc9f/packages/sql/README.md
[channels-sql-slots]: https://github.com/humanlayer/effect-channels/blob/b2e25f40620e98c67b9aa11d67203722adc9bc9f/packages/sql/src/DeliverySlot.ts
[channels-storage]: https://github.com/humanlayer/effect-channels/blob/b2e25f40620e98c67b9aa11d67203722adc9bc9f/packages/delivery/src/ChannelsStorage.ts
[channels-example]: https://github.com/humanlayer/effect-channels/blob/b2e25f40620e98c67b9aa11d67203722adc9bc9f/examples/alchemy-cloudflare/README.md
[channels-manifest]: https://github.com/humanlayer/effect-channels/blob/b2e25f40620e98c67b9aa11d67203722adc9bc9f/package.json
