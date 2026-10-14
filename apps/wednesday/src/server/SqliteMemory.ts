import { replyContext } from '../shared/replies.ts'
import { Effect, PartitionedSemaphore, Schema } from 'effect'
import type { SqlClient } from 'effect/sql'
import { ChatMessage } from '../shared/protocol.ts'
import { MemoryState, MemoryJob, Node, Part } from './Storage.ts'
import { failure } from './errors.ts'

const LegacyMemory = Schema.Struct({
  parts: Schema.Array(Part),
  nodes: Schema.Array(Node),
  pending: Schema.Boolean,
})
const decodeLegacy = Schema.decodeEffect(Schema.fromJsonString(LegacyMemory))
const decodeState = Schema.decodeEffect(Schema.fromJsonString(MemoryState))
const encodeState = Schema.encodeEffect(Schema.fromJsonString(MemoryState))
const decodeNodes = Schema.decodeUnknownEffect(Schema.Array(Node))
const decodeJobs = Schema.decodeUnknownEffect(Schema.Array(MemoryJob))
const decodeMessages = Schema.decodeUnknownEffect(Schema.Array(ChatMessage))
const database = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(() => failure('Memory storage operation failed.')))
const emptyState = () =>
  ({
    parts: [],
    pending: false,
    revision: 0,
    compactParts: [],
    compactPending: false,
    compactRevision: -1,
    total: 0,
    frontier: 0,
  }) satisfies MemoryState

// Run once when upgrading the original JSON memory adapter; preserve its live view and nodes.
export const migrateMemory = Effect.fn('SqliteMemory.migrate')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql`CREATE TABLE wednesday_memory_views (user_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`
  yield* sql`CREATE TABLE wednesday_memory_nodes (user_id TEXT NOT NULL, id INTEGER NOT NULL, count INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(user_id, count, id))`
  yield* sql`CREATE TABLE wednesday_memory_jobs (user_id TEXT NOT NULL, id INTEGER NOT NULL, count INTEGER NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', PRIMARY KEY(user_id, count, id))`
  yield* sql`CREATE INDEX wednesday_memory_ready ON wednesday_memory_jobs(user_id, status, count, id)`
  const users = yield* sql<{ user_id: string }>`SELECT DISTINCT user_id FROM wednesday_messages`
  for (const { user_id: userId } of users) {
    const rows = yield* sql<{
      payload: string
    }>`SELECT payload FROM wednesday_memory WHERE user_id = ${userId}`
    const legacy = rows[0]
      ? yield* decodeLegacy(rows[0].payload)
      : { parts: [], nodes: [], pending: false }
    for (const node of legacy.nodes)
      yield* sql`INSERT INTO wednesday_memory_nodes (user_id,id,count,text) VALUES (${userId},${node.id},${node.count},${node.text})`
    const messages = yield* sql<{
      id: number
      kind: string
      text: string
    }>`SELECT id,kind,text FROM wednesday_messages WHERE user_id = ${userId} ORDER BY id`
    const covered = legacy.parts.reduce((sum, part) => sum + part.count, 0)
    const state = {
      ...emptyState(),
      parts: [
        ...legacy.parts,
        ...messages
          .filter((message) => message.id >= covered)
          .map((message) => ({ id: message.id, count: 1 })),
      ],
      pending: legacy.pending,
    }
    yield* sql`INSERT INTO wednesday_memory_views (user_id,payload) VALUES (${userId},${yield* encodeState(state)})`
  }
  yield* sql`INSERT INTO wednesday_memory_jobs (user_id,id,count,source) SELECT m.user_id,m.id,1,m.kind || ': ' || m.text FROM wednesday_messages m LEFT JOIN wednesday_memory_nodes n ON n.user_id=m.user_id AND n.id=m.id AND n.count=1 WHERE n.id IS NULL`
  yield* sql`INSERT OR IGNORE INTO wednesday_memory_jobs (user_id,id,count,source) SELECT a.user_id,a.id,a.count*2,a.text || char(10) || b.text FROM wednesday_memory_nodes a JOIN wednesday_memory_nodes b ON b.user_id=a.user_id AND b.count=a.count AND b.id=a.id+a.count LEFT JOIN wednesday_memory_nodes p ON p.user_id=a.user_id AND p.count=a.count*2 AND p.id=a.id WHERE a.id % (a.count*2)=0 AND p.id IS NULL`
})

export const makeSqliteMemory = Effect.fn('SqliteMemory.make')(function* (
  sql: SqlClient.SqlClient,
) {
  const locks = yield* PartitionedSemaphore.make<string>({ permits: 1 })
  const withMemory = <A, E, R>(userId: string, effect: Effect.Effect<A, E, R>) =>
    locks.withPermit(userId)(effect)
  const memory = Effect.fn('Storage.memory')(function* (userId: string) {
    const rows = yield* sql<{
      payload: string
    }>`SELECT payload FROM wednesday_memory_views WHERE user_id=${userId}`
    const state = rows[0] ? yield* decodeState(rows[0].payload) : emptyState()
    const totals = yield* sql<{
      total: number
    }>`SELECT COALESCE(MAX(id)+1,0) AS total FROM wednesday_messages WHERE user_id=${userId}`
    const missing = yield* sql<{
      frontier: number | null
    }>`SELECT MIN(id) AS frontier FROM wednesday_memory_jobs WHERE user_id=${userId} AND count=1`
    const total = totals[0]?.total ?? 0
    const { total: _total, frontier: _frontier, ...view } = state
    return { ...view, total, frontier: missing[0]?.frontier ?? total }
  }, database)
  const saveMemory = Effect.fn('Storage.saveMemory')(function* (
    userId: string,
    state: MemoryState,
  ) {
    const payload = yield* encodeState(state)
    yield* sql`INSERT INTO wednesday_memory_views (user_id,payload) VALUES (${userId},${payload}) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload`
  }, database)
  const recordMessages = Effect.fn('SqliteMemory.recordMessages')(function* (
    userId: string,
    messages: readonly ChatMessage[],
  ) {
    if (!messages.length) return
    const state = yield* memory(userId)
    for (const message of messages)
      yield* sql`INSERT INTO wednesday_memory_jobs (user_id,id,count,source) VALUES (${userId},${message.id},1,${`${message.kind}: ${replyContext(message)}`})`
    yield* saveMemory(userId, {
      ...state,
      parts: [...state.parts, ...messages.map((message) => ({ id: message.id, count: 1 }))],
    })
  })
  const memoryNodes = Effect.fn('Storage.memoryNodes')(function* (
    userId: string,
    parts: readonly (typeof Part.Type)[],
  ) {
    const rows = yield* Effect.forEach(
      parts,
      (part) =>
        sql`SELECT id,count,text FROM wednesday_memory_nodes WHERE user_id=${userId} AND id=${part.id} AND count=${part.count}`,
    )
    return yield* decodeNodes(rows.flat())
  }, database)
  const memoryJobs = Effect.fn('Storage.memoryJobs')(function* (userId: string, capacity: number) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const state = yield* memory(userId)
        const jobs = yield* decodeJobs(
          yield* sql`SELECT id,count,source FROM wednesday_memory_jobs WHERE user_id=${userId} AND status='queued' AND (count>1 OR id<=COALESCE((SELECT id FROM wednesday_memory_jobs WHERE user_id=${userId} AND count=1 ORDER BY id LIMIT 1 OFFSET 7),${state.total})) ORDER BY count,id LIMIT ${capacity}`,
        )
        for (const job of jobs)
          yield* sql`UPDATE wednesday_memory_jobs SET status='running' WHERE user_id=${userId} AND id=${job.id} AND count=${job.count}`
        return jobs
      }),
    )
  }, database)
  const completeMemoryJob = Effect.fn('Storage.completeMemoryJob')(function* (
    userId: string,
    node: typeof Node.Type,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT OR IGNORE INTO wednesday_memory_nodes (user_id,id,count,text) VALUES (${userId},${node.id},${node.count},${node.text})`
        yield* sql`DELETE FROM wednesday_memory_jobs WHERE user_id=${userId} AND id=${node.id} AND count=${node.count}`
        const id = Math.floor(node.id / (node.count * 2)) * (node.count * 2)
        yield* sql`INSERT OR IGNORE INTO wednesday_memory_jobs (user_id,id,count,source) SELECT a.user_id,a.id,a.count*2,a.text || char(10) || b.text FROM wednesday_memory_nodes a JOIN wednesday_memory_nodes b ON b.user_id=a.user_id AND b.count=a.count AND b.id=a.id+a.count LEFT JOIN wednesday_memory_nodes p ON p.user_id=a.user_id AND p.count=a.count*2 AND p.id=a.id WHERE a.user_id=${userId} AND a.id=${id} AND a.count=${node.count} AND p.id IS NULL`
      }),
    )
  }, database)
  const failMemoryJob = Effect.fn('Storage.failMemoryJob')(function* (
    userId: string,
    part: typeof Part.Type,
  ) {
    yield* sql`UPDATE wednesday_memory_jobs SET status='failed' WHERE user_id=${userId} AND id=${part.id} AND count=${part.count}`
  }, database)
  const retryMemoryJobs = Effect.fn('Storage.retryMemoryJobs')(function* (userId: string) {
    yield* sql`UPDATE wednesday_memory_jobs SET status='queued' WHERE user_id=${userId} AND status IN ('failed','running')`
  }, database)
  const message = Effect.fn('Storage.message')(function* (userId: string, id: number) {
    const messages = yield* decodeMessages(
      yield* sql`SELECT id,kind,text,date FROM wednesday_messages WHERE user_id=${userId} AND id=${id}`,
    )
    return messages[0] ?? null
  }, database)
  return {
    withMemory,
    memory,
    saveMemory,
    recordMessages,
    memoryNodes,
    memoryJobs,
    completeMemoryJob,
    failMemoryJob,
    retryMemoryJobs,
    message,
  }
})
