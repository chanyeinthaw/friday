import { ToolActivity } from '../shared/Activity.ts'
import { toolActivity, decodeToolArguments, emptyToolArguments } from './Activity.ts'
import { Attachment } from '../shared/Attachments.ts'
import { DateTime, Effect, Layer, Schema, Option } from 'effect'
import { SqlClient } from 'effect/sql'
import {
  encodedContentParts,
  encodedContentText,
  EventId,
  storedLogEntry,
  LogEntry,
  type LogEntryInput,
} from '@humanlayer/fold-core'
import { ChatMessage, MessageReply, type PendingMessage } from '../shared/protocol.ts'
import {
  Storage,
  Migrations,
  StoredSettings,
  type StoredAttachment,
  type ExpiredAttachment,
} from './Storage.ts'
import { makeSqliteMemory, migrateMemory } from './SqliteMemory.ts'
import { clipToolOutput, splitText } from './MessageSizing.ts'
import { failure } from './errors.ts'

const settingsCodec = Schema.fromJsonString(StoredSettings)
const logCodec = Schema.fromJsonString(LogEntry)
const decodeSettings = Schema.decodeEffect(settingsCodec)
const encodeSettings = Schema.encodeEffect(settingsCodec)
const decodeLog = Schema.decodeEffect(logCodec)
const encodeLog = Schema.encodeEffect(logCodec)
const attachmentsCodec = Schema.fromJsonString(Schema.Array(Attachment))
const decodeAttachments = Schema.decodeEffect(attachmentsCodec)
const encodeAttachments = Schema.encodeEffect(attachmentsCodec)
const fileCodec = Schema.fromJsonString(Attachment)
const decodeFile = Schema.decodeEffect(fileCodec)
const encodeFile = Schema.encodeEffect(fileCodec)
const activityCodec = Schema.fromJsonString(ToolActivity)
const decodeActivity = Schema.decodeEffect(activityCodec)
const encodeActivity = Schema.encodeEffect(activityCodec)
const replyCodec = Schema.fromJsonString(MessageReply)
const decodeReply = Schema.decodeEffect(replyCodec)
const encodeReply = Schema.encodeEffect(replyCodec)
const restoreReply = Effect.fn('Storage.restoreReply')(function* <
  A extends { reply: string | null; attachments: string | null; activity: string | null },
>(row: A) {
  const { reply, attachments, activity, ...message } = row
  const quoted = reply ? { ...message, reply: yield* decodeReply(reply) } : message
  const files = attachments
    ? { ...quoted, attachments: yield* decodeAttachments(attachments) }
    : quoted
  return activity ? { ...files, activity: yield* decodeActivity(activity) } : files
})
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
        return splitText(`${part.name}(${JSON.stringify(part.params)})`).map((text, index) => {
          const message = { kind: 'tool' as const, text, date }
          if (index > 0) return message
          return {
            ...message,
            activity: toolActivity(
              part.id,
              part.name,
              Option.getOrElse(decodeToolArguments(part.params), () => emptyToolArguments),
            ),
          }
        })
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
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{
              version: number
            }>`SELECT version FROM wednesday_migrations WHERE version=4`
            if (existing.length) return
            yield* sql`ALTER TABLE wednesday_messages ADD COLUMN reply TEXT`
            yield* sql`INSERT INTO wednesday_migrations (version) VALUES (4)`
          }),
        )
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{
              version: number
            }>`SELECT version FROM wednesday_migrations WHERE version=5`
            if (existing.length) return
            yield* sql`CREATE TABLE wednesday_attachments (user_id TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', expires_at INTEGER NOT NULL DEFAULT (unixepoch()+86400), staging_cleaned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,id))`
            yield* sql`ALTER TABLE wednesday_messages ADD COLUMN attachments TEXT`
            yield* sql`INSERT INTO wednesday_migrations (version) VALUES (5)`
          }),
        )
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{
              version: number
            }>`SELECT version FROM wednesday_migrations WHERE version=6`
            if (existing.length) return
            yield* sql`CREATE TABLE wednesday_integrations (user_id TEXT NOT NULL, integration TEXT NOT NULL, encrypted_key TEXT NOT NULL, PRIMARY KEY(user_id,integration))`
            yield* sql`INSERT INTO wednesday_migrations (version) VALUES (6)`
          }),
        )
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{
              version: number
            }>`SELECT version FROM wednesday_migrations WHERE version=7`
            if (existing.length) return
            yield* sql`ALTER TABLE wednesday_messages ADD COLUMN activity TEXT`
            yield* sql`ALTER TABLE wednesday_messages ADD COLUMN tool_id TEXT`
            yield* sql`CREATE INDEX wednesday_tool_activity ON wednesday_messages(user_id,tool_id)`
            yield* sql`INSERT INTO wednesday_migrations (version) VALUES (7)`
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
    const integrationKey = Effect.fn('Storage.integrationKey')(function* (
      userId: string,
      integration: 'firecrawl',
    ) {
      const rows = yield* sql<{
        encrypted_key: string
      }>`SELECT encrypted_key FROM wednesday_integrations WHERE user_id=${userId} AND integration=${integration}`
      return rows[0]?.encrypted_key ?? null
    }, database)
    const saveIntegrationKey = Effect.fn('Storage.saveIntegrationKey')(function* (
      userId: string,
      integration: 'firecrawl',
      encryptedKey: string | null,
    ) {
      if (encryptedKey === null) {
        yield* sql`DELETE FROM wednesday_integrations WHERE user_id=${userId} AND integration=${integration}`
      } else {
        yield* sql`INSERT INTO wednesday_integrations (user_id,integration,encrypted_key) VALUES (${userId},${integration},${encryptedKey}) ON CONFLICT(user_id,integration) DO UPDATE SET encrypted_key=excluded.encrypted_key`
      }
    }, database)
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
        yield* Effect.forEach(
          (yield* sql<{
            id: number
            kind: string
            text: string
            date: string
            requestId: string | null
            reply: string | null
            attachments: string | null
            activity: string | null
          }>`SELECT id, kind, text, date, request_id AS requestId, reply, attachments, activity FROM wednesday_messages WHERE user_id = ${userId} AND (id > ${afterId} OR (id > ${afterId - 500} AND activity IS NOT NULL)) ORDER BY id`).map(
            ({ requestId, ...row }) => (requestId ? { ...row, requestId } : row),
          ),
          restoreReply,
        ),
      )
    }, database)
    const history = Effect.fn('Storage.history')(function* (
      userId: string,
      beforeId = Number.MAX_SAFE_INTEGER,
    ) {
      const rows = yield* sql<{
        id: number
        kind: string
        text: string
        date: string
        requestId: string | null
        reply: string | null
        attachments: string | null
        activity: string | null
      }>`SELECT id, kind, text, date, request_id AS requestId, reply, attachments, activity FROM wednesday_messages WHERE user_id = ${userId} AND id < ${beforeId} AND kind IN ('user', 'talk') ORDER BY id DESC LIMIT 251`
      const first = rows[Math.min(rows.length, 250) - 1]?.id ?? beforeId
      const tools = yield* sql<{
        id: number
        kind: string
        text: string
        date: string
        requestId: string | null
        reply: string | null
        attachments: string | null
        activity: string | null
      }>`SELECT id,kind,'' AS text,date,request_id AS requestId,reply,attachments,activity FROM wednesday_messages WHERE user_id=${userId} AND id>=${first} AND id<${beforeId} AND kind='tool' AND activity IS NOT NULL ORDER BY id DESC LIMIT 500`
      return {
        messages: yield* decodeMessages(
          yield* Effect.forEach(
            [...rows.slice(0, 250), ...tools]
              .sort((a, b) => a.id - b.id)
              .map(({ requestId, ...row }) => (requestId ? { ...row, requestId } : row)),
            restoreReply,
          ),
        ),
        hasOlder: rows.length > 250,
      }
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
    const outputPreview = (text: string) =>
      text.length > 4000 ? text.slice(0, 4000) + '\n…' : text
    const updateActivities = Effect.fn('Storage.updateActivities')(function* (
      userId: string,
      entry: LogEntry,
    ) {
      const updates: ChatMessage[] = []
      if (entry._tag === 'tool-result') {
        for (const part of entry.message.content) {
          if (part.type !== 'tool-result') continue
          const matches = yield* sql<{
            id: number
            date: string
            activity: string
          }>`SELECT id,date,activity FROM wednesday_messages WHERE user_id=${userId} AND tool_id=${part.id} AND activity IS NOT NULL`
          for (const row of matches) {
            const activity = {
              ...(yield* decodeActivity(row.activity)),
              status: part.isFailure ? ('failed' as const) : ('completed' as const),
              output: outputPreview(
                isString(part.result) ? part.result : JSON.stringify(part.result),
              ),
            }
            yield* sql`UPDATE wednesday_messages SET activity=${yield* encodeActivity(activity)} WHERE user_id=${userId} AND id=${row.id}`
            updates.push({ id: row.id, date: row.date, kind: 'tool', text: '', activity })
          }
        }
      }
      return updates
    })
    const appendLog = Effect.fn('Storage.appendLog')(function* (
      userId: string,
      input: LogEntryInput,
      consumedRequestId: string | null,
      messageDate?: string,
      submission?: Pick<PendingMessage, 'text' | 'reply' | 'attachments'>,
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
            // Keep quoted context in the agent log, and the original draft in the chat bubble.
            const visibleEntry =
              submission && entry._tag === 'user-message'
                ? { ...entry, message: { ...entry.message, content: submission.text } }
                : entry
            const added = projection(visibleEntry).map((item, index): ChatMessage => {
              const message = { ...item, id: (counts[0]?.next ?? 0) + index }
              if (index !== 0 || item.kind !== 'user' || !consumedRequestId) return message
              const visible = {
                ...message,
                requestId: consumedRequestId,
                date: messageDate ?? message.date,
              }
              const quoted = submission?.reply ? { ...visible, reply: submission.reply } : visible
              return submission?.attachments?.length
                ? { ...quoted, attachments: submission.attachments }
                : quoted
            })
            for (const message of added) {
              const reply = message.reply ? yield* encodeReply(message.reply) : null
              const attachments = message.attachments
                ? yield* encodeAttachments(message.attachments)
                : null
              const activity = message.activity ? yield* encodeActivity(message.activity) : null
              yield* sql`INSERT INTO wednesday_messages (user_id, id, kind, text, date, request_id, reply, attachments, activity, tool_id) VALUES (${userId}, ${message.id}, ${message.kind}, ${message.text}, ${message.date}, ${message.requestId ?? null}, ${reply}, ${attachments}, ${activity}, ${message.activity?.id ?? null})`
            }
            if (submission?.attachments?.length)
              yield* commitAttachments(
                userId,
                submission.attachments.map((file) => file.id),
              )
            yield* memoryStorage.recordMessages(userId, added)
            const updates = yield* updateActivities(userId, entry)
            return { entry, messages: [...added, ...updates] }
          }),
        ),
      )
    }, database)
    const saveAttachment = Effect.fn('Storage.saveAttachment')(function* (
      userId: string,
      file: Attachment,
    ) {
      const payload = yield* encodeFile(file)
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const usage = yield* sql<{
            bytes: number
          }>`SELECT COALESCE(SUM(json_extract(payload,'$.size')),0) AS bytes FROM wednesday_attachments WHERE user_id=${userId}`
          if ((usage[0]?.bytes ?? 0) + file.size > 512 * 1024 * 1024)
            return yield* failure('Your attachment storage is full.')
          yield* sql`INSERT INTO wednesday_attachments (user_id,id,payload) VALUES (${userId},${file.id},${payload})`
        }),
      )
    }, database)
    const attachment = Effect.fn('Storage.attachment')(function* (userId: string, id: string) {
      const rows = yield* sql<{
        payload: string
        state: StoredAttachment['state']
      }>`SELECT payload,state FROM wednesday_attachments WHERE user_id=${userId} AND id=${id} AND state!='deleting'`
      return rows[0] ? { ...(yield* decodeFile(rows[0].payload)), state: rows[0].state } : null
    }, database)
    const attachments = Effect.fn('Storage.attachments')(function* (userId: string) {
      const rows = yield* sql<{
        payload: string
      }>`SELECT payload FROM wednesday_attachments WHERE user_id=${userId} AND state='used' ORDER BY rowid`
      return yield* Effect.forEach(rows, (row) => decodeFile(row.payload))
    }, database)
    const completeAttachment = Effect.fn('Storage.completeAttachment')(function* (
      userId: string,
      id: string,
    ) {
      const rows =
        yield* sql`UPDATE wednesday_attachments SET state='ready' WHERE user_id=${userId} AND id=${id} AND state='pending' RETURNING id`
      if (!rows.length)
        return yield* failure('This upload has expired. Please attach the file again.')
    }, database)
    const commitAttachments = Effect.fn('Storage.commitAttachments')(function* (
      userId: string,
      ids: readonly string[],
    ) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const id of ids) {
            const rows =
              yield* sql`UPDATE wednesday_attachments SET state='used' WHERE user_id=${userId} AND id=${id} AND state IN ('ready','used') RETURNING id`
            if (!rows.length)
              return yield* failure('This attachment has expired. Please attach it again.')
          }
        }),
      )
    }, database)
    const claimExpiredAttachments = Effect.fn('Storage.claimExpiredAttachments')(function* () {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows =
            yield* sql<ExpiredAttachment>`SELECT user_id AS userId,id,state FROM wednesday_attachments WHERE expires_at<unixepoch() AND (state!='used' OR staging_cleaned=0) LIMIT 100`
          for (const row of rows)
            if (row.state !== 'used')
              yield* sql`UPDATE wednesday_attachments SET state='deleting' WHERE user_id=${row.userId} AND id=${row.id}`
          return rows.map((row) => ({
            ...row,
            state: row.state === 'used' ? ('used' as const) : ('deleting' as const),
          }))
        }),
      )
    }, database)
    const finishAttachmentCleanup = Effect.fn('Storage.finishAttachmentCleanup')(function* (
      userId: string,
      id: string,
    ) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM wednesday_attachments WHERE user_id=${userId} AND id=${id} AND state='deleting'`
          yield* sql`UPDATE wednesday_attachments SET staging_cleaned=1 WHERE user_id=${userId} AND id=${id} AND state='used'`
        }),
      )
    }, database)
    const settleActivities = Effect.fn('Storage.settleActivities')(function* (userId: string) {
      const rows = yield* sql<{
        id: number
        date: string
        activity: string
      }>`SELECT id,date,activity FROM wednesday_messages WHERE user_id=${userId} AND json_extract(activity,'$.status')='running'`
      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const activity = { ...(yield* decodeActivity(row.activity)), status: 'stopped' as const }
          yield* sql`UPDATE wednesday_messages SET activity=${yield* encodeActivity(activity)} WHERE user_id=${userId} AND id=${row.id}`
          return { id: row.id, date: row.date, kind: 'tool' as const, text: '', activity }
        }),
      )
    }, database)
    const recover = Effect.fn('Storage.recover')(function* () {
      yield* sql`UPDATE wednesday_memory_jobs SET status='queued' WHERE status='running'`
      yield* sql`UPDATE wednesday_messages SET activity=json_set(activity,'$.status','stopped') WHERE json_extract(activity,'$.status')='running'`
    }, database)
    return Storage.of({
      settleActivities,
      integrationKey,
      saveIntegrationKey,
      saveAttachment,
      attachment,
      attachments,
      commitAttachments,
      completeAttachment,
      claimExpiredAttachments,
      finishAttachmentCleanup,
      settings,
      history,
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
