# Vercel Chat SDK integration with Friday and Effect

## Scope

Investigate Vercel Chat SDK as Friday's external-platform boundary, with Discord first. Determine whether Friday needs an Effect bridge, who owns lifecycle and persistence, and how inbound concurrency relates to Friday steering.

Primary source revision: Vercel Chat SDK repository commit [`caab5c3843de4cd90a5e98a2c865a32ec7118250`](https://github.com/vercel/chat/tree/caab5c3843de4cd90a5e98a2c865a32ec7118250).

## Findings

### 1. Chat SDK is a Promise/callback framework

A `Chat` instance registers callback handlers such as `onNewMention` and `onSubscribedMessage`. Handler types return `void | Promise<void>`. Chat SDK dispatches inbound messages to those handlers and awaits their Promises.

Sources:

- [`MentionHandler` and `SubscribedMessageHandler`](https://github.com/vercel/chat/blob/caab5c3843de4cd90a5e98a2c865a32ec7118250/packages/chat/src/types.ts#L1832-L1920)
- [README usage example](https://github.com/vercel/chat/blob/caab5c3843de4cd90a5e98a2c865a32ec7118250/README.md#L31-L53)

Friday therefore needs an Effect bridge at the registered callback boundary:

```ts
const effectContext = yield * Effect.context()
const runPromise = Effect.runPromiseWith(effectContext)

chat.onSubscribedMessage((thread, message, context) =>
  runPromise(ingestExternalMessage({ thread, message, context })),
)
```

This is simpler than Pi's bridge. Pi emits synchronous events into a queue-backed Stream and ignores returned listener Promises. Chat SDK handlers are already Promise-aware and await completion. Friday does not need a second callback queue merely to enter Effect.

### 2. Chat SDK lifecycle must be scoped by Effect

`Chat.initialize()` connects the configured state adapter and initializes all platform adapters. `Chat.shutdown()` calls optional adapter `disconnect()` hooks, disconnects the state adapter, and resets initialization state.

Sources:

- [`Chat.doInitialize`, `Chat.shutdown`, and `Chat.initialize`](https://github.com/vercel/chat/blob/caab5c3843de4cd90a5e98a2c865a32ec7118250/packages/chat/src/chat.ts#L405-L493)
- [`Adapter.disconnect`](https://github.com/vercel/chat/blob/caab5c3843de4cd90a5e98a2c865a32ec7118250/packages/chat/src/types.ts#L239-L245)
- [`StateAdapter.connect` and `disconnect`](https://github.com/vercel/chat/blob/caab5c3843de4cd90a5e98a2c865a32ec7118250/packages/chat/src/types.ts#L883-L908)

Friday should construct Chat SDK with `Effect.acquireRelease`:

```ts
const chat =
  yield *
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => createAndInitializeChat(),
      catch: ExternalPlatformInitializationError.fromCause,
    }),
    (chat) =>
      Effect.tryPromise({
        try: () => chat.shutdown(),
        catch: () => undefined,
      }).pipe(Effect.ignore),
  )
```

For a resident Discord Gateway, Friday must also scope its `AbortController`. The Discord adapter's gateway listener accepts an `AbortSignal`, owns the Discord client, and destroys that client in `finally`.

Source:

- [`DiscordAdapter.startGatewayListener` and `runGatewayListener`](https://github.com/vercel/chat/blob/caab5c3843de4cd90a5e98a2c865a32ec7118250/packages/adapter-discord/src/index.ts#L2099-L2281)

### 3. Webhook handling is a direct Promise bridge

Chat SDK exposes adapter-specific handlers such as `chat.webhooks.discord(request)`. The handler lazily initializes Chat SDK, verifies and parses the request through the adapter, dispatches handlers, and returns a `Promise<Response>`.

Sources:

- [`Chat.webhooks` construction and `handleWebhook`](https://github.com/vercel/chat/blob/caab5c3843de4cd90a5e98a2c865a32ec7118250/packages/chat/src/chat.ts#L380-L427)
- [Express Discord example](https://github.com/vercel/chat/blob/caab5c3843de4cd90a5e98a2c865a32ec7118250/examples/express-discord-chat/src/index.ts)

An Effect HTTP route can wrap it directly:

```ts
Effect.tryPromise({
  try: () => chat.webhooks.discord(request),
  catch: (cause) => new ExternalPlatformWebhookError({ platform: 'discord', cause }),
})
```

The raw request body must remain unparsed until Discord signature verification. The official Express example explicitly warns against global JSON parsing for this route.

### 4. Outbound publication should be an Effect service

A Chat SDK `Thread` posts through Promise methods such as `thread.post(...)`. A thread handle can be reconstructed from its full external thread ID with `chat.thread(threadId)`.

Sources:

- [`Chat.thread(threadId)`](https://github.com/vercel/chat/blob/caab5c3843de4cd90a5e98a2c865a32ec7118250/packages/chat/src/chat.ts#L1981-L2030)
- [`ThreadImpl.post`](https://github.com/vercel/chat/blob/caab5c3843de4cd90a5e98a2c865a32ec7118250/packages/chat/src/thread.ts#L406-L474)

Friday should hide Chat SDK behind an application service, for example:

```ts
interface ExternalPlatformContract {
  readonly publishFinalMessage: (input: {
    externalThreadId: ExternalThreadId
    text: string
  }) => Effect.Effect<ExternalMessageId, ExternalPlatformPublishError>
}
```

The implementation calls `chat.thread(externalThreadId).post(text)` through `Effect.tryPromise`. Domain and coordinator code must not depend on Chat SDK `Thread`, `Message`, or adapter classes.

### 5. Chat SDK state is not Friday conversation persistence

Chat SDK requires a `StateAdapter`. It uses this state for platform subscription status, deduplication, locks, queueing, thread state, and optional history/transcripts. Its interface includes connect/disconnect, subscription, locking, queue, list, and key-value methods.

Source:

- [`StateAdapter`](https://github.com/vercel/chat/blob/caab5c3843de4cd90a5e98a2c865a32ec7118250/packages/chat/src/types.ts#L883-L940)

This state must not replace Friday's SQLite-owned Thread, Turn, Activity, and harness-session state. They represent different facts:

```text
Chat SDK state
  platform subscription
  webhook deduplication
  handler lock/queue
  SDK thread state

Friday SQLite
  ChannelThread / AgentThread
  Turn lifecycle
  Activity snapshots
  Pi harness resume cursor
  external binding
```

For Friday's resident, standalone, single-user process, Redis is the wrong operational dependency. Chat SDK memory state remains useful for component tests, but it loses subscriptions and deduplication state on restart. Friday should implement a small SQLite-backed Chat SDK `StateAdapter` in the existing `${FRIDAY_HOME}/friday.sqlite` database. This preserves standalone deployment and keeps platform state beside Friday's other durable state without conflating their table ownership.

Effect provides relevant building blocks but not a drop-in Chat SDK state backend:

- `effect/unstable/persistence/KeyValueStore.layerSql` supplies SQL-backed string/binary get, set, remove, clear, and size, but it has no TTL-aware atomic `setIfNotExists`, subscription set, append-only list, or FIFO queue operations.
- `effect/unstable/persistence/Persistence` stores schema-encoded `Exit` values for `Persistable` requests; that data model does not match Chat SDK state.
- `effect/unstable/persistence/PersistedQueue` has a SQL store, but its work-claim, retry, acknowledgement, and worker-lock semantics differ from Chat SDK's bounded queue/dequeue/depth contract.
- Effect SQL's Bun SQLite client is useful directly: it serializes access, enables WAL and a busy timeout by default, and uses `BEGIN IMMEDIATE` for explicit writable transactions.
- `PartitionedSemaphore` is useful for Friday's process-local per-external-binding ingestion serialization, not as durable Chat SDK state.

The SQLite adapter should use dedicated `chat_sdk_*` tables and Effect SQL transactions for compound atomic operations. JSON-compatible values should be encoded and decoded through Effect Schema rather than direct `JSON.parse` calls.

### 6. Chat SDK concurrency must not decide Friday Turn versus steering

Chat SDK defaults to `drop` when another handler is processing the same thread. Its `queue` strategy does not deliver every queued message as a separate handler invocation: after the active handler finishes it dispatches only the latest queued message and supplies earlier messages in `context.skipped`. `burst` behaves similarly, while `debounce` discards superseded messages.

Sources:

- [Overlapping Messages documentation](https://github.com/vercel/chat/blob/caab5c3843de4cd90a5e98a2c865a32ec7118250/apps/docs/content/docs/concurrency.mdx)
- [`Chat.handleQueueOrDebounce` and `drainQueue`](https://github.com/vercel/chat/blob/caab5c3843de4cd90a5e98a2c865a32ec7118250/packages/chat/src/chat.ts#L2360-L2643)

These semantics conflict with Friday's rule that input received during an active Turn is steering and remains part of that Turn. Friday must make the disposition decision itself.

Recommended initial setting:

```ts
new Chat({
  concurrency: 'concurrent',
  // ...
})
```

Then Friday's ingestion service serializes decisions per external binding:

```text
inbound Chat SDK message
  normalize external identifiers and content
  acquire Friday ingestion lock for external channel/thread
  find or create ChannelThread
  if Friday Turn is active
    persist Steering Activity
    coordinator.steer(...)
  else
    persist/create pending Turn
    coordinator.prompt(...)
  release ingestion lock
```

An alternative is to make each Chat SDK handler return immediately after appending the inbound message to a durable Friday inbox. A Friday worker then performs ordered ingestion. That is stronger for crash recovery and webhook latency, but delivery tracking and ingestion are currently deferred.

Do not configure Chat SDK `queue` and assume it implements Friday steering. It delays messages until the current handler completes and may collapse several messages into one handler call.

### 7. Chat SDK input acceptance and Friday delivery remain separate

`Chat.processMessage` creates a Promise for message processing. If `waitUntil` is provided, it registers a tracked Promise whose errors are logged and swallowed for platform retry behavior, while the returned task itself still rejects.

Source:

- [`Chat.processMessage`](https://github.com/vercel/chat/blob/caab5c3843de4cd90a5e98a2c865a32ec7118250/packages/chat/src/chat.ts#L949-L985)

Friday should decide explicitly when the external webhook may acknowledge the platform:

- Synchronous v1: handler Promise completes after Friday persists and submits the input to the coordinator, but not after the full agent Turn completes.
- Durable-inbox design: acknowledge after the inbound message is durably appended; process it asynchronously.

The final agent message must be published only after the coordinator has persisted the terminal Turn event, preserving Friday's persist-before-publication rule.

### 8. External identifiers map cleanly, but platform Thread is not Friday Thread

Chat SDK supplies normalized `thread.id` and `thread.channelId`. A thread handle is serializable and reconstructable, but Friday should persist only the needed external identifiers in its own contract.

Sources:

- [`SerializedThread`](https://github.com/vercel/chat/blob/caab5c3843de4cd90a5e98a2c865a32ec7118250/packages/chat/src/thread.ts#L45-L55)
- [`ThreadImpl.toJSON` and `fromJSON`](https://github.com/vercel/chat/blob/caab5c3843de4cd90a5e98a2c865a32ec7118250/packages/chat/src/thread.ts#L996-L1042)

Suggested mapping:

```text
Chat SDK thread.channelId → Friday ExternalChannelId
Chat SDK thread.id        → Friday ExternalThreadId
Chat SDK message.id       → Friday ExternalMessageId
adapter.name              → Friday ExternalPlatform
```

Chat SDK `Thread` is a platform operation handle. Friday `Thread` is the durable agent conversation aggregate. They must remain distinct despite sharing the word “Thread.”

Discord adds an important product choice: top-level Discord messages may be represented with per-message or native Discord thread semantics, while Friday currently says one long-lived ChannelThread per external channel. Ingestion should key the Friday ChannelThread by the intended external binding policy, not blindly use Chat SDK `thread.id` as Friday's identity.

## Recommended architecture

```text
Discord / Slack / future platform
  ↓
Vercel Chat SDK adapter
  verifies webhook or owns Gateway
  normalizes platform Message + Thread
  ↓ Promise callback bridge
ChatSdkExternalPlatform (Effect adapter)
  captures Effect Context
  converts SDK values to Friday input
  typed initialization / webhook / publish errors
  scoped initialize / shutdown / Gateway abort
  ↓
ExternalIngestion (Friday application service)
  per-binding serialization
  find/create ChannelThread
  choose new Turn or steering
  persistence-first coordinator call
  ↓
FridayApplication.openThread
  ThreadCoordinator
  PiThreadRuntime
  SQLite
  ↓ persisted terminal Turn
ExternalPublisher
  chat.thread(externalThreadId).post(finalAgentMessage)
```

## Proposed module boundaries

```text
apps/friday/src/external/
├── ExternalIngestion.ts          # harness/platform-neutral disposition logic
├── ExternalPlatform.ts           # Effect service contract for publication/lifecycle
└── chat-sdk/
    ├── ChatSdkExternalPlatform.ts # Promise/callback bridge
    ├── DiscordLive.ts             # Chat + Discord adapter construction
    ├── Errors.ts                  # typed init/webhook/publish errors
    ├── MessageProjection.ts       # pure Chat SDK → Friday normalization
    └── SqliteStateAdapter.ts      # standalone durable Chat SDK state
```

## Testing seams

1. **Pure projection test**
   - Chat SDK thread/message fixture → Friday external identifiers and input message.
2. **Fake Chat SDK component test**
   - registered callback enters captured Effect context;
   - Promise success/failure propagates correctly;
   - scope close calls `chat.shutdown()`;
   - publication reconstructs thread and calls `post`.
3. **Local ingestion integration test**
   - fake Chat SDK inbound message → ingestion → real SQLite → fake Pi runtime;
   - first message creates a Turn;
   - overlapping second message becomes steering.
4. **Opt-in live Discord test**
   - real adapter initialization and API publication to a configured test thread;
   - do not include in ordinary `pnpm test`.

## Conclusion

Yes, Friday needs a bridge around Chat SDK because Chat SDK is Promise/callback based and Friday's application services are Effect based. It should resemble the Pi bridge in these respects:

- capture Effect context once;
- convert external callbacks to `runPromiseWith(context)(effect)`;
- wrap outbound Promises with typed `Effect.tryPromise` errors;
- own initialization and cleanup in an Effect scope.

It should not copy Pi's queue-backed Stream bridge. Chat SDK already awaits handler Promises and provides normalized inbound callbacks. Friday's own ingestion service—not Chat SDK's concurrency queue—must decide whether each input starts a Turn or steers the active Turn.
