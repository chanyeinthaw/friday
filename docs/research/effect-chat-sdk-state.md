# Effect and SQLite for Vercel Chat SDK state

## Decision context

Friday is currently:

- a standalone Bun executable;
- single-player and expected to run as one resident process;
- already backed by `${FRIDAY_HOME}/friday.sqlite` through Effect SQL;
- not a distributed worker fleet;
- required to preserve external-platform subscriptions and webhook deduplication across restarts.

Question: can an existing Effect persistence abstraction implement Vercel Chat SDK's `StateAdapter`, or should Friday add a SQLite-backed adapter?

## Chat SDK contract

Chat SDK `StateAdapter` requires these capabilities:

```text
subscriptions
  subscribe
  unsubscribe
  isSubscribed

leases / locks
  acquireLock with TTL
  extendLock
  releaseLock by token
  forceReleaseLock

TTL key-value state
  get
  set
  setIfNotExists atomically
  delete

ordered bounded lists
  appendToList
  getList

ordered bounded queues
  enqueue
  dequeue atomically
  queueDepth

lifecycle
  connect
  disconnect
```

Source: Vercel Chat SDK [`StateAdapter`](https://github.com/vercel/chat/blob/caab5c3843de4cd90a5e98a2c865a32ec7118250/packages/chat/src/types.ts#L883-L945).

Even with Chat SDK `concurrency: "concurrent"`, durable key-value state is still needed because Chat SDK performs atomic message deduplication before concurrency dispatch using `setIfNotExists(dedupeKey, true, ttl)`.

Source: [`Chat.routeIncomingMessage`](https://github.com/vercel/chat/blob/caab5c3843de4cd90a5e98a2c865a32ec7118250/packages/chat/src/chat.ts#L2150-L2222).

## Effect capabilities reviewed

Effect revision in Friday: `effect@4.0.0-rc.109` from [Effect-TS/effect](https://github.com/Effect-TS/effect).

### SQL KeyValueStore

`effect/unstable/persistence/KeyValueStore.layerSql` creates a SQL table and implements string/binary `get`, `set`, `remove`, `clear`, and `size`.

Source: [`KeyValueStore.layerSql`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/unstable/persistence/KeyValueStore.ts).

It does not provide:

- entry expiration;
- atomic set-if-absent with expired-row replacement;
- subscriptions;
- append-only bounded lists;
- FIFO queue operations.

It therefore cannot directly satisfy Chat SDK's `StateAdapter`. Wrapping it would still require separate SQL tables and transactions for most of the contract, so using it for only the cache table would increase indirection without removing meaningful implementation work.

### Persistence

`effect/unstable/persistence/Persistence` stores schema-encoded `Exit` values keyed by `Persistable` requests and supports TTL. SQL-backed layers are available.

Source: [`Persistence`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/unstable/persistence/Persistence.ts).

This abstraction is designed for persisted request results. Chat SDK stores arbitrary JSON values, subscriptions, leases, ordered lists, and queue entries. Adapting those concepts into `Persistable` request exits would be a semantic mismatch.

### PersistedQueue

`effect/unstable/persistence/PersistedQueue` includes a SQL-backed queue store. It supports id-based deduplication, scoped work claims, retries, acknowledgement, lock refresh, and failed attempts.

Source: [`PersistedQueue`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/unstable/persistence/PersistedQueue.ts).

Chat SDK's queue contract is different:

```text
enqueue(threadId, entry, maxSize) → current depth
dequeue(threadId)                 → oldest entry or null
queueDepth(threadId)              → current depth
```

Chat SDK itself owns queue-entry expiry, bounded trimming, skipped-message aggregation, and dispatch. Effect PersistedQueue would duplicate or fight those semantics. It should not back Chat SDK's queue methods.

Effect PersistedQueue may become useful later for Friday's own durable ingestion inbox or external publication outbox, where acknowledgement and retries are appropriate.

### PartitionedSemaphore

Effect's `PartitionedSemaphore<K>` provides keyed, process-local concurrency control.

Source: [`PartitionedSemaphore`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/PartitionedSemaphore.ts).

This is appropriate for Friday's ingestion decision boundary:

```ts
const lock = yield * PartitionedSemaphore.make<string>({ permits: 1 })

lock.withPermit(externalBindingKey)(decideNewTurnOrSteering(message))
```

It is not durable and should not implement Chat SDK leases. For one Friday process, that is acceptable for active in-process ingestion serialization. SQLite remains authoritative for durable state.

### Bun SQLite client

`@effect/sql-sqlite-bun`:

- uses Bun's synchronous SQLite driver;
- serializes database access with a semaphore;
- enables WAL by default;
- configures a five-second busy timeout by default;
- uses `BEGIN IMMEDIATE` for writable transactions.

Source: [`@effect/sql-sqlite-bun/SqliteClient`](https://github.com/Effect-TS/effect/tree/main/packages/sql/sqlite-bun).

This is a good foundation for a small custom adapter because Chat SDK's compound operations can be made atomic with `sql.withTransaction`.

## Recommendation

Implement `SqliteChatStateAdapter` over the existing Friday SQLite client and database file.

Do not add Redis. Do not create a second SQLite file. Do not force Chat SDK state into Friday conversation tables.

```text
${FRIDAY_HOME}/friday.sqlite
├── Friday-owned tables
│   ├── threads
│   ├── turns
│   └── activities
└── Chat SDK adapter-owned tables
    ├── chat_sdk_subscriptions
    ├── chat_sdk_locks
    ├── chat_sdk_cache
    ├── chat_sdk_lists
    └── chat_sdk_queues
```

The adapter can closely follow Vercel's first-party PostgreSQL state adapter table model while translating timestamp and SQL syntax for SQLite.

Source: [`@chat-adapter/state-pg`](https://github.com/vercel/chat/blob/caab5c3843de4cd90a5e98a2c865a32ec7118250/packages/state-pg/src/index.ts).

## Solo-use simplifications

Friday only needs one process and one user now. This allows intentional simplifications without violating Chat SDK's interface.

### Lifecycle

The Effect SQLite layer owns the actual database connection. Therefore:

```text
connect
  ensure migrations ran
  mark adapter connected

disconnect
  mark adapter disconnected
  do not close SQLite directly
```

The application Effect scope closes SQLite after Chat SDK shutdown.

### Chat SDK concurrency

Use:

```ts
concurrency: 'concurrent'
```

Friday will serialize ingestion decisions per external binding with `PartitionedSemaphore`. This avoids Chat SDK `drop`, `queue`, `burst`, or `debounce` altering Friday's steering semantics.

Because Chat SDK still invokes `setIfNotExists` for deduplication under `concurrent`, durable cache support remains necessary.

### Locks and queues

With Chat SDK `concurrent`, Chat SDK's lock and queue methods should normally not be used for inbound messages. They still need correct implementations because they are part of the interface and future configuration may use them. Keep them small and transactionally correct; do not optimize for distributed contention.

### Transcripts and Chat SDK thread history

Do not configure Chat SDK transcripts or optional persistent thread history initially. Friday already owns channel context and conversation history. This means `appendToList` and `getList` are primarily contract completeness until a specific Chat SDK feature needs them.

### Subscriptions

Friday may not need Chat SDK `thread.subscribe()` if Discord is configured to route all messages from explicitly allowed channel IDs through `onNewMention`-style handling. However, durable subscriptions are cheap and preserve the option to use `onSubscribedMessage`. Implement them correctly rather than relying on memory state.

## Proposed SQLite schema

Use integer epoch milliseconds for expiration and timestamps so comparisons are simple and deterministic.

```sql
CREATE TABLE chat_sdk_subscriptions (
  key_prefix TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key_prefix, thread_id)
);

CREATE TABLE chat_sdk_locks (
  key_prefix TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key_prefix, thread_id)
);

CREATE INDEX chat_sdk_locks_expires_idx
ON chat_sdk_locks (expires_at);

CREATE TABLE chat_sdk_cache (
  key_prefix TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key_prefix, cache_key)
);

CREATE INDEX chat_sdk_cache_expires_idx
ON chat_sdk_cache (expires_at);

CREATE TABLE chat_sdk_lists (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  key_prefix TEXT NOT NULL,
  list_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  expires_at INTEGER
);

CREATE INDEX chat_sdk_lists_key_idx
ON chat_sdk_lists (key_prefix, list_key, sequence);

CREATE INDEX chat_sdk_lists_expires_idx
ON chat_sdk_lists (expires_at);

CREATE TABLE chat_sdk_queues (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  key_prefix TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  value_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX chat_sdk_queues_key_idx
ON chat_sdk_queues (key_prefix, thread_id, sequence);

CREATE INDEX chat_sdk_queues_expires_idx
ON chat_sdk_queues (expires_at);
```

## Atomic operation shapes

### Deduplication

`setIfNotExists` must insert a missing key or replace only an expired key in one transaction.

```text
BEGIN IMMEDIATE
  delete matching expired row
  insert-or-ignore new row
  inspect affected row count
COMMIT
```

This preserves Chat SDK's atomic duplicate suppression.

### Lock acquisition

```text
BEGIN IMMEDIATE
  delete matching expired lock
  insert-or-ignore new token + expiry
  return lock only if inserted
COMMIT
```

Release and extension must include the ownership token in the predicate.

### Append list

```text
BEGIN IMMEDIATE
  delete expired entries for key
  insert new entry
  trim oldest entries above maxLength
  if ttl supplied
    refresh expiry for all entries under key
COMMIT
```

### Queue enqueue

```text
BEGIN IMMEDIATE
  delete expired queue entries for thread
  insert new entry
  trim oldest entries above maxSize
  count remaining entries
COMMIT
```

### Queue dequeue

SQLite supports deleting the oldest matching row and returning its payload. Perform it within the serialized Effect SQL transaction.

## Encoding

Chat SDK state values and queue entries are JSON-compatible at runtime, but Friday's repository forbids direct `JSON.parse`. Use Effect Schema codecs:

```ts
const encodeJson = Schema.encodeSync(Schema.toCodecJson(Schema.Json))
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))
```

Use a narrow schema for `QueueEntry` if the Chat SDK package exports enough structural types; otherwise use `Schema.Json` at the external adapter boundary and validate required fields after decoding.

## Testing

Add Bun SQLite integration tests because the adapter uses `bun:sqlite`:

1. subscription survives reopening SQLite;
2. `setIfNotExists` rejects an unexpired duplicate and accepts after expiry;
3. lock token ownership and expiry behavior;
4. append list ordering, trimming, and TTL refresh;
5. FIFO queue ordering, trimming, expiry, and atomic dequeue;
6. Chat SDK component test using real `Chat`, fake platform adapter, and real SQLite state;
7. two overlapping inbound messages reach Friday ingestion rather than being dropped or collapsed.

## Conclusion

Use SQLite.

Effect provides the correct low-level pieces—Effect SQL transactions, the Bun SQLite client, schemas, and `PartitionedSemaphore`—but no existing Effect persistence abstraction matches Vercel Chat SDK's complete state contract. A focused SQLite Chat SDK state adapter is smaller and semantically clearer than composing `KeyValueStore`, `Persistence`, and `PersistedQueue` into a mismatched abstraction.
