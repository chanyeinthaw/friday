/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, eslint/no-underscore-dangle, typescript/no-unsafe-type-assertion -- Chat SDK's StateAdapter defines arbitrary JSON values and caller-selected get<T>; implemented methods validate values through Effect Schema before crossing that SDK interface. */

import { Message, type SerializedMessage, type StateAdapter } from 'chat'
import * as Clock from 'effect/Clock'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

const JsonString = Schema.fromJsonString(Schema.Json)
const isSerializedMessage = (value: unknown): value is SerializedMessage => {
  if (typeof value !== 'object' || value === null) return false
  // SAFETY: The preceding object/null guard establishes a dictionary-shaped
  // representation; every required SerializedMessage field is checked below.
  const record = value as Record<string, unknown>
  return (
    record._type === 'chat:Message' &&
    typeof record.id === 'string' &&
    typeof record.threadId === 'string' &&
    typeof record.text === 'string' &&
    Array.isArray(record.attachments) &&
    typeof record.author === 'object' &&
    record.author !== null &&
    typeof record.formatted === 'object' &&
    record.formatted !== null &&
    typeof record.metadata === 'object' &&
    record.metadata !== null
  )
}
const SerializedMessageJson = Schema.declare<SerializedMessage>(isSerializedMessage)
const QueueEntryJson = Schema.Struct({
  enqueuedAt: Schema.Finite,
  expiresAt: Schema.Finite,
  message: SerializedMessageJson,
})
const QueueEntryString = Schema.fromJsonString(QueueEntryJson)
const encodeJson = Schema.encodeUnknownEffect(JsonString)
const decodeJson = Schema.decodeUnknownEffect(JsonString)
const encodeQueueEntry = Schema.encodeUnknownEffect(QueueEntryString)
const decodeQueueEntry = Schema.decodeUnknownEffect(QueueEntryString)

export const runChatSdkStateMigrations = Effect.fn('runChatSdkStateMigrations')(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_sdk_subscriptions (
      key_prefix TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (key_prefix, thread_id)
    )
  `
  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_sdk_locks (
      key_prefix TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (key_prefix, thread_id)
    )
  `
  yield* sql`
    CREATE INDEX IF NOT EXISTS chat_sdk_locks_expires_idx
    ON chat_sdk_locks (expires_at)
  `
  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_sdk_lists (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      key_prefix TEXT NOT NULL,
      list_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      expires_at INTEGER
    )
  `
  yield* sql`
    CREATE INDEX IF NOT EXISTS chat_sdk_lists_key_idx
    ON chat_sdk_lists (key_prefix, list_key, sequence)
  `
  yield* sql`
    CREATE INDEX IF NOT EXISTS chat_sdk_lists_expires_idx
    ON chat_sdk_lists (expires_at)
  `
  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_sdk_queues (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      key_prefix TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      value_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `
  yield* sql`
    CREATE INDEX IF NOT EXISTS chat_sdk_queues_key_idx
    ON chat_sdk_queues (key_prefix, thread_id, sequence)
  `
  yield* sql`
    CREATE INDEX IF NOT EXISTS chat_sdk_queues_expires_idx
    ON chat_sdk_queues (expires_at)
  `
  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_sdk_cache (
      key_prefix TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      expires_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (key_prefix, cache_key)
    )
  `
  yield* sql`
    CREATE INDEX IF NOT EXISTS chat_sdk_cache_expires_idx
    ON chat_sdk_cache (expires_at)
  `
})

export const makeSqliteChatStateAdapter = Effect.fn('makeSqliteChatStateAdapter')(function* (
  keyPrefix = 'friday',
) {
  const sql = yield* SqlClient.SqlClient
  const crypto = yield* Crypto.Crypto
  const effectContext = yield* Effect.context()
  const runPromise = Effect.runPromiseWith(effectContext)
  let connected = false

  const ensureConnected = Effect.sync(() => {
    if (!connected) throw new Error('SqliteChatStateAdapter is not connected.')
  })

  return {
    connect: () =>
      runPromise(
        runChatSdkStateMigrations().pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.andThen(
            Effect.sync(() => {
              connected = true
            }),
          ),
        ),
      ),
    disconnect: () =>
      runPromise(
        Effect.sync(() => {
          connected = false
        }),
      ),
    subscribe: (threadId) =>
      runPromise(
        Effect.gen(function* () {
          yield* ensureConnected
          const now = yield* Clock.currentTimeMillis
          yield* sql`
              INSERT OR IGNORE INTO chat_sdk_subscriptions
                (key_prefix, thread_id, created_at)
              VALUES (${keyPrefix}, ${threadId}, ${now})
            `
        }),
      ),
    unsubscribe: (threadId) =>
      runPromise(
        ensureConnected.pipe(
          Effect.andThen(sql`
              DELETE FROM chat_sdk_subscriptions
              WHERE key_prefix = ${keyPrefix} AND thread_id = ${threadId}
            `),
          Effect.asVoid,
        ),
      ),
    isSubscribed: (threadId) =>
      runPromise(
        Effect.gen(function* () {
          yield* ensureConnected
          const rows = yield* sql<{ readonly found: number }>`
              SELECT 1 AS found
              FROM chat_sdk_subscriptions
              WHERE key_prefix = ${keyPrefix} AND thread_id = ${threadId}
              LIMIT 1
            `
          return rows.length > 0
        }),
      ),
    get: <T>(key: string): Promise<T | null> =>
      runPromise(
        Effect.gen(function* () {
          yield* ensureConnected
          const now = yield* Clock.currentTimeMillis
          const rows = yield* sql<{ readonly value_json: string }>`
              SELECT value_json
              FROM chat_sdk_cache
              WHERE key_prefix = ${keyPrefix}
                AND cache_key = ${key}
                AND (expires_at IS NULL OR expires_at > ${now})
              LIMIT 1
            `
          const row = rows[0]
          if (!row) {
            yield* sql`
                DELETE FROM chat_sdk_cache
                WHERE key_prefix = ${keyPrefix}
                  AND cache_key = ${key}
                  AND expires_at IS NOT NULL
                  AND expires_at <= ${now}
              `
            return null
          }
          // SAFETY: StateAdapter.get<T> makes T caller-selected; Schema.Json validates
          // the stored representation before this unavoidable SDK boundary assertion.
          return (yield* decodeJson(row.value_json)) as T
        }),
      ),
    set: <T>(key: string, value: T, ttlMs?: number) =>
      runPromise(
        Effect.gen(function* () {
          yield* ensureConnected
          const now = yield* Clock.currentTimeMillis
          const expiresAt = ttlMs === undefined ? null : now + ttlMs
          const valueJson = yield* encodeJson(value)
          yield* sql`
              INSERT INTO chat_sdk_cache
                (key_prefix, cache_key, value_json, expires_at, updated_at)
              VALUES (${keyPrefix}, ${key}, ${valueJson}, ${expiresAt}, ${now})
              ON CONFLICT(key_prefix, cache_key) DO UPDATE SET
                value_json = excluded.value_json,
                expires_at = excluded.expires_at,
                updated_at = excluded.updated_at
            `
        }),
      ),
    setIfNotExists: (key, value, ttlMs) =>
      runPromise(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* ensureConnected
            const now = yield* Clock.currentTimeMillis
            const expiresAt = ttlMs === undefined ? null : now + ttlMs
            const valueJson = yield* encodeJson(value)
            yield* sql`
                DELETE FROM chat_sdk_cache
                WHERE key_prefix = ${keyPrefix}
                  AND cache_key = ${key}
                  AND expires_at IS NOT NULL
                  AND expires_at <= ${now}
              `
            const inserted = yield* sql<{ readonly cache_key: string }>`
                INSERT OR IGNORE INTO chat_sdk_cache
                  (key_prefix, cache_key, value_json, expires_at, updated_at)
                VALUES (${keyPrefix}, ${key}, ${valueJson}, ${expiresAt}, ${now})
                RETURNING cache_key
              `
            return inserted.length > 0
          }),
        ),
      ),
    delete: (key) =>
      runPromise(
        ensureConnected.pipe(
          Effect.andThen(sql`
              DELETE FROM chat_sdk_cache
              WHERE key_prefix = ${keyPrefix} AND cache_key = ${key}
            `),
          Effect.asVoid,
        ),
      ),
    acquireLock: (threadId, ttlMs) =>
      runPromise(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* ensureConnected
            const now = yield* Clock.currentTimeMillis
            const token = yield* crypto.randomUUIDv4
            const expiresAt = now + ttlMs
            yield* sql`
                DELETE FROM chat_sdk_locks
                WHERE key_prefix = ${keyPrefix}
                  AND thread_id = ${threadId}
                  AND expires_at <= ${now}
              `
            const inserted = yield* sql<{ readonly thread_id: string }>`
                INSERT OR IGNORE INTO chat_sdk_locks
                  (key_prefix, thread_id, token, expires_at, updated_at)
                VALUES (${keyPrefix}, ${threadId}, ${token}, ${expiresAt}, ${now})
                RETURNING thread_id
              `
            return inserted.length === 0 ? null : { threadId, token, expiresAt }
          }),
        ),
      ),
    forceReleaseLock: (threadId) =>
      runPromise(
        ensureConnected.pipe(
          Effect.andThen(sql`
              DELETE FROM chat_sdk_locks
              WHERE key_prefix = ${keyPrefix} AND thread_id = ${threadId}
            `),
          Effect.asVoid,
        ),
      ),
    releaseLock: (lock) =>
      runPromise(
        ensureConnected.pipe(
          Effect.andThen(sql`
              DELETE FROM chat_sdk_locks
              WHERE key_prefix = ${keyPrefix}
                AND thread_id = ${lock.threadId}
                AND token = ${lock.token}
            `),
          Effect.asVoid,
        ),
      ),
    extendLock: (lock, ttlMs) =>
      runPromise(
        Effect.gen(function* () {
          yield* ensureConnected
          const now = yield* Clock.currentTimeMillis
          const expiresAt = now + ttlMs
          const updated = yield* sql<{ readonly thread_id: string }>`
              UPDATE chat_sdk_locks
              SET expires_at = ${expiresAt}, updated_at = ${now}
              WHERE key_prefix = ${keyPrefix}
                AND thread_id = ${lock.threadId}
                AND token = ${lock.token}
                AND expires_at > ${now}
              RETURNING thread_id
            `
          return updated.length > 0
        }),
      ),
    appendToList: (key, value, options) =>
      runPromise(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* ensureConnected
            const now = yield* Clock.currentTimeMillis
            const expiresAt = options?.ttlMs === undefined ? null : now + options.ttlMs
            const valueJson = yield* encodeJson(value)
            yield* sql`
                DELETE FROM chat_sdk_lists
                WHERE key_prefix = ${keyPrefix}
                  AND list_key = ${key}
                  AND expires_at IS NOT NULL
                  AND expires_at <= ${now}
              `
            yield* sql`
                INSERT INTO chat_sdk_lists
                  (key_prefix, list_key, value_json, expires_at)
                VALUES (${keyPrefix}, ${key}, ${valueJson}, ${expiresAt})
              `
            if (options?.maxLength !== undefined) {
              yield* sql`
                  DELETE FROM chat_sdk_lists
                  WHERE sequence IN (
                    SELECT sequence FROM chat_sdk_lists
                    WHERE key_prefix = ${keyPrefix} AND list_key = ${key}
                    ORDER BY sequence DESC
                    LIMIT -1 OFFSET ${options.maxLength}
                  )
                `
            }
            if (expiresAt !== null) {
              yield* sql`
                  UPDATE chat_sdk_lists
                  SET expires_at = ${expiresAt}
                  WHERE key_prefix = ${keyPrefix} AND list_key = ${key}
                `
            }
          }),
        ),
      ),
    getList: <T>(key: string): Promise<T[]> =>
      runPromise(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* ensureConnected
            const now = yield* Clock.currentTimeMillis
            yield* sql`
                DELETE FROM chat_sdk_lists
                WHERE key_prefix = ${keyPrefix}
                  AND list_key = ${key}
                  AND expires_at IS NOT NULL
                  AND expires_at <= ${now}
              `
            const rows = yield* sql<{ readonly value_json: string }>`
                SELECT value_json FROM chat_sdk_lists
                WHERE key_prefix = ${keyPrefix} AND list_key = ${key}
                ORDER BY sequence ASC
              `
            const values: T[] = []
            for (const row of rows) {
              // SAFETY: StateAdapter.getList<T> makes T caller-selected; each stored
              // representation is validated as JSON before this SDK boundary assertion.
              values.push((yield* decodeJson(row.value_json)) as T)
            }
            return values
          }),
        ),
      ),
    enqueue: (threadId, entry, maxSize) =>
      runPromise(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* ensureConnected
            const now = yield* Clock.currentTimeMillis
            const valueJson = yield* encodeQueueEntry({
              ...entry,
              message: entry.message.toJSON(),
            })
            yield* sql`
                DELETE FROM chat_sdk_queues
                WHERE key_prefix = ${keyPrefix}
                  AND thread_id = ${threadId}
                  AND expires_at <= ${now}
              `
            yield* sql`
                INSERT INTO chat_sdk_queues
                  (key_prefix, thread_id, value_json, expires_at)
                VALUES (${keyPrefix}, ${threadId}, ${valueJson}, ${entry.expiresAt})
              `
            if (maxSize > 0) {
              yield* sql`
                  DELETE FROM chat_sdk_queues
                  WHERE sequence IN (
                    SELECT sequence FROM chat_sdk_queues
                    WHERE key_prefix = ${keyPrefix} AND thread_id = ${threadId}
                    ORDER BY sequence DESC
                    LIMIT -1 OFFSET ${maxSize}
                  )
                `
            }
            const rows = yield* sql<{ readonly depth: number }>`
                SELECT COUNT(*) AS depth FROM chat_sdk_queues
                WHERE key_prefix = ${keyPrefix}
                  AND thread_id = ${threadId}
                  AND expires_at > ${now}
              `
            return Number(rows[0]?.depth ?? 0)
          }),
        ),
      ),
    dequeue: (threadId) =>
      runPromise(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* ensureConnected
            const now = yield* Clock.currentTimeMillis
            yield* sql`
                DELETE FROM chat_sdk_queues
                WHERE key_prefix = ${keyPrefix}
                  AND thread_id = ${threadId}
                  AND expires_at <= ${now}
              `
            const rows = yield* sql<{ readonly value_json: string }>`
                DELETE FROM chat_sdk_queues
                WHERE sequence = (
                  SELECT sequence FROM chat_sdk_queues
                  WHERE key_prefix = ${keyPrefix} AND thread_id = ${threadId}
                  ORDER BY sequence ASC
                  LIMIT 1
                )
                RETURNING value_json
              `
            const row = rows[0]
            if (!row) return null
            const queueEntry = yield* decodeQueueEntry(row.value_json)
            return {
              ...queueEntry,
              message: Message.fromJSON(queueEntry.message),
            }
          }),
        ),
      ),
    queueDepth: (threadId) =>
      runPromise(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* ensureConnected
            const now = yield* Clock.currentTimeMillis
            yield* sql`
                DELETE FROM chat_sdk_queues
                WHERE key_prefix = ${keyPrefix}
                  AND thread_id = ${threadId}
                  AND expires_at <= ${now}
              `
            const rows = yield* sql<{ readonly depth: number }>`
                SELECT COUNT(*) AS depth FROM chat_sdk_queues
                WHERE key_prefix = ${keyPrefix} AND thread_id = ${threadId}
              `
            return Number(rows[0]?.depth ?? 0)
          }),
        ),
      ),
  } satisfies StateAdapter
})
