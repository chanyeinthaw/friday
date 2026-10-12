import { DateTime, Effect, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import {
  encodedContentParts,
  encodedContentText,
  EventId,
  storedLogEntry,
  LogEntry,
  type LogEntryInput,
} from '@humanlayer/fold-core'
import { ChatMessage } from '../shared/protocol.ts'
import { Storage, Migrations, StoredSettings } from './Storage.ts'
import { makeSqliteMemory, migrateMemory } from './SqliteMemory.ts'
import { clipToolOutput, splitText } from './MessageSizing.ts'
import { failure } from './errors.ts'

const settingsCodec = Schema.fromJsonString(StoredSettings)
const logCodec = Schema.fromJsonString(LogEntry)
const decodeSettings = Schema.decodeEffect(settingsCodec)
const encodeSettings = Schema.encodeEffect(settingsCodec)
const decodeLog = Schema.decodeEffect(logCodec)
const encodeLog = Schema.encodeEffect(logCodec)
const decodeMessages = Schema.decodeUnknownEffect(Schema.Array(ChatMessage))
const database = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(() => failure('Database operation failed.')))
const isString = Schema.is(Schema.String)
// Reasoning stays out of the durable log and summary tree.
const durableInput = (input: LogEntryInput): LogEntryInput => {
  if (input._tag === 'assistant-message') {
    const { message, ...envelope } = input
    const { content, ...metadata } = message
    return {
      ...envelope,
      message: {
        ...metadata,
        content: isString(content) ? content : content.filter((part) => part.type !== 'reasoning'),
      },
    }
  }
  if (input._tag === 'tool-result') {
    const { message, ...envelope } = input
    const { content, ...metadata } = message
    return {
      ...envelope,
      message: {
        ...metadata,
        content: content.map((part) => {
          if (part.type !== 'tool-result') return part
          const { result, ...detail } = part
          const text = isString(result) ? result : JSON.stringify(result)
          return { ...detail, result: clipToolOutput(text) }
        }),
      },
    }
  }
  return input
}
const projection = (entry: LogEntry): readonly Omit<ChatMessage, 'id'>[] => {
  const date = DateTime.formatIso(DateTime.makeUnsafe(entry.ts))
  if (entry._tag === 'user-message') {
    return splitText(encodedContentText(entry.message.content)).map((text) => ({
      kind: 'user',
      text,
      date,
    }))
  }
  if (entry._tag === 'assistant-message') {
    const content = encodedContentParts(entry.message.content)
    return content.flatMap<Omit<ChatMessage, 'id'>>((part) => {
      if (part.type === 'text')
        return splitText(part.text).map((text) => ({ kind: 'talk' as const, text, date }))
      if (part.type === 'tool-call')
        return splitText(`${part.name}(${JSON.stringify(part.params)})`).map((text) => ({
          kind: 'tool' as const,
          text,
          date,
        }))
      return []
    })
  }
  if (entry._tag === 'tool-result')
    return [{ kind: 'echo', text: clipToolOutput(JSON.stringify(entry.message.content)), date }]
  return []
}

export const sqliteMigrations = Layer.effect(
  Migrations,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const run = Effect.fn('SqliteMigrations.run')(
      function* () {
        yield* sql`PRAGMA synchronous = FULL`
        yield* sql`CREATE TABLE IF NOT EXISTS wednesday_migrations (version INTEGER PRIMARY KEY)`
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{
              version: number
            }>`SELECT version FROM wednesday_migrations WHERE version = 1`
            if (existing.length > 0) return
            yield* sql`CREATE TABLE wednesday_settings (user_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`
            yield* sql`CREATE TABLE wednesday_logs (user_id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(user_id, seq))`
            yield* sql`CREATE TABLE wednesday_messages (user_id TEXT NOT NULL, id INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, date TEXT NOT NULL, PRIMARY KEY(user_id, id))`
            yield* sql`CREATE TABLE wednesday_memory (user_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`
            yield* sql`INSERT INTO wednesday_migrations (version) VALUES (1)`
          }),
        )
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{
              version: number
            }>`SELECT version FROM wednesday_migrations WHERE version=2`
            if (existing.length) return
            yield* migrateMemory(sql)
            yield* sql`INSERT INTO wednesday_migrations (version) VALUES (2)`
          }),
        )
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{
              version: number
            }>`SELECT version FROM wednesday_migrations WHERE version=3`
            if (existing.length) return
            yield* sql`ALTER TABLE wednesday_messages ADD COLUMN request_id TEXT`
            yield* sql`DROP TABLE IF EXISTS wednesday_submissions`
            yield* sql`INSERT INTO wednesday_migrations (version) VALUES (3)`
          }),
        )
      },
      (effect) => effect.pipe(Effect.mapError(() => failure('Database migration failed.'))),
    )
    return Migrations.of({ run })
  }),
)

export const sqliteStorage = Layer.effect(
  Storage,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const migrations = yield* Migrations
    yield* migrations.run()
    const settings = Effect.fn('Storage.settings')(function* (userId: string) {
      const rows = yield* sql<{
        payload: string
      }>`SELECT payload FROM wednesday_settings WHERE user_id = ${userId}`
      return rows[0] ? yield* decodeSettings(rows[0].payload) : null
    }, database)
    const saveSettings = Effect.fn('Storage.saveSettings')(function* (
      userId: string,
      value: StoredSettings,
    ) {
      const payload = yield* encodeSettings(value)
      yield* sql`INSERT INTO wednesday_settings (user_id, payload) VALUES (${userId}, ${payload}) ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload`
    }, database)
    const messages = Effect.fn('Storage.messages')(function* (userId: string, afterId = -1) {
      return yield* decodeMessages(
        (yield* sql<{
          id: number
          kind: string
          text: string
          date: string
          requestId: string | null
        }>`SELECT id, kind, text, date, request_id AS requestId FROM wednesday_messages WHERE user_id = ${userId} AND id > ${afterId} ORDER BY id`).map(
          ({ requestId, ...row }) => (requestId ? { ...row, requestId } : row),
        ),
      )
    }, database)
    const memoryStorage = yield* makeSqliteMemory(sql)
    const logSequence = Effect.fn('Storage.logSequence')(function* (userId: string) {
      const rows = yield* sql<{
        next: number
      }>`SELECT COALESCE(MAX(seq)+1,0) AS next FROM wednesday_logs WHERE user_id=${userId}`
      return rows[0]?.next ?? 0
    }, database)
    const logs = Effect.fn('Storage.logs')(function* (userId: string, fromSeq = 0) {
      const rows = yield* sql<{
        payload: string
      }>`SELECT payload FROM wednesday_logs WHERE user_id = ${userId} AND seq>=${fromSeq} ORDER BY seq`
      return yield* Effect.forEach(rows, (row) => decodeLog(row.payload))
    }, database)
    const appendLog = Effect.fn('Storage.appendLog')(function* (
      userId: string,
      input: LogEntryInput,
      consumedRequestId: string | null,
      messageDate?: string,
    ) {
      return yield* memoryStorage.withMemory(
        userId,
        sql.withTransaction(
          Effect.gen(function* () {
            const totals = yield* sql<{
              next: number
            }>`SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM wednesday_logs WHERE user_id = ${userId}`
            const entry = yield* storedLogEntry(
              durableInput(input),
              totals[0]?.next ?? 0,
              EventId.create(),
            )
            const payload = yield* encodeLog(entry)
            yield* sql`INSERT INTO wednesday_logs (user_id, seq, payload) VALUES (${userId}, ${entry.seq}, ${payload})`
            const counts = yield* sql<{
              next: number
            }>`SELECT COALESCE(MAX(id) + 1, 0) AS next FROM wednesday_messages WHERE user_id = ${userId}`
            const added = projection(entry).map((item, index) => {
              const message = { ...item, id: (counts[0]?.next ?? 0) + index }
              return index === 0 && item.kind === 'user' && consumedRequestId
                ? { ...message, requestId: consumedRequestId, date: messageDate ?? message.date }
                : message
            })
            for (const message of added)
              yield* sql`INSERT INTO wednesday_messages (user_id, id, kind, text, date, request_id) VALUES (${userId}, ${message.id}, ${message.kind}, ${message.text}, ${message.date}, ${message.requestId ?? null})`
            yield* memoryStorage.recordMessages(userId, added)
            return { entry, messages: added }
          }),
        ),
      )
    }, database)
    const recover = Effect.fn('Storage.recover')(function* () {
      yield* sql`UPDATE wednesday_memory_jobs SET status='queued' WHERE status='running'`
    }, database)
    return Storage.of({
      settings,
      saveSettings,
      messages,
      ...memoryStorage,
      logs,
      logSequence,
      appendLog,
      recover,
    })
  }),
)
