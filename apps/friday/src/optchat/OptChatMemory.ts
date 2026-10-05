import * as Exit from 'effect/Exit'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as PartitionedSemaphore from 'effect/PartitionedSemaphore'
import { PiDurableError } from '../harness/pi/PiDurableError.ts'
import {
  bytes,
  fitView,
  nodeKey,
  renderView,
  validRange,
  type MemoryNode,
  type MemoryPart,
} from './OptChatTree.ts'
import type { Compress } from './OptChatCompactor.ts'

const isPiDurableError = Schema.is(PiDurableError)
const memoryError = (cause: unknown) =>
  isPiDurableError(cause) ? cause : new PiDurableError({ operation: 'optchat-memory', cause })

export const MemoryMessage = Schema.Struct({
  id: Schema.Int,
  sourceKey: Schema.String,
  kind: Schema.Literals(['user', 'talk', 'tool', 'echo', 'work', 'note']),
  text: Schema.String,
  date: Schema.String,
})
export type MemoryMessage = typeof MemoryMessage.Type
const Node = Schema.Struct({ id: Schema.Int, count: Schema.Int, text: Schema.String })
const Part = Schema.Struct({ id: Schema.Int, count: Schema.Int })
const partCodec = Schema.fromJsonString(Schema.Array(Part))
const decodeMessages = Schema.decodeUnknownEffect(Schema.Array(MemoryMessage))
const decodeNodes = Schema.decodeUnknownEffect(Schema.Array(Node))
const decodeParts = Schema.decodeUnknownEffect(partCodec)
const encodeParts = Schema.encodeEffect(partCodec)
export interface MemoryInput extends Omit<MemoryMessage, 'id'> {}
export interface OptChatMemory {
  readonly append: (
    memoryId: string,
    messages: readonly MemoryInput[],
  ) => Effect.Effect<void, PiDurableError>
  readonly settle: (memoryId: string) => Effect.Effect<string, PiDurableError>
  readonly pump: (memoryId: string) => Effect.Effect<void, PiDurableError>
  readonly zoom: (
    memoryId: string,
    id: number,
    count: number,
  ) => Effect.Effect<string, PiDurableError>
  readonly date: (memoryId: string, id: number) => Effect.Effect<string, PiDurableError>
}

/** Missing nodes are the persisted work queue; a restart resumes without rebuilding completed nodes. */
export const makeOptChatMemory = Effect.fn('OptChat.makeMemory')(function* (
  compress: Compress,
  budget?: number,
) {
  const sql = yield* SqlClient.SqlClient
  const locks = yield* PartitionedSemaphore.make<string>({ permits: 1 })
  yield* sql`CREATE TABLE IF NOT EXISTS optchat_messages (memory_id TEXT NOT NULL, id INTEGER NOT NULL, source_key TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, date TEXT NOT NULL, PRIMARY KEY (memory_id, id), UNIQUE(memory_id, source_key))`
  yield* sql`CREATE TABLE IF NOT EXISTS optchat_nodes (memory_id TEXT NOT NULL, id INTEGER NOT NULL, count INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(memory_id, id, count))`
  yield* sql`CREATE TABLE IF NOT EXISTS optchat_progress (memory_id TEXT PRIMARY KEY, complete_total INTEGER NOT NULL)`
  yield* sql`CREATE TABLE IF NOT EXISTS optchat_views (memory_id TEXT PRIMARY KEY, parts TEXT NOT NULL)`
  const load = Effect.fn('OptChat.load')(
    function* (memoryId: string) {
      const messages = yield* decodeMessages(
        yield* sql`SELECT id, source_key AS sourceKey, kind, text, date FROM optchat_messages WHERE memory_id = ${memoryId} ORDER BY id`,
      )
      const rows = yield* decodeNodes(
        yield* sql`SELECT id, count, text FROM optchat_nodes WHERE memory_id = ${memoryId}`,
      )
      const nodes = new Map(rows.map((node) => [nodeKey(node), node]))
      const views = yield* sql<{
        parts: string
      }>`SELECT parts FROM optchat_views WHERE memory_id = ${memoryId}`
      const parts = views[0] === undefined ? [] : yield* decodeParts(views[0].parts)
      return { messages, nodes, parts }
    },
    (effect) => effect.pipe(Effect.mapError(memoryError)),
  )
  const saveView = Effect.fn('OptChat.saveView')(function* (
    memoryId: string,
    parts: readonly MemoryPart[],
  ) {
    const encoded = yield* encodeParts(parts)
    yield* sql`INSERT INTO optchat_views (memory_id, parts) VALUES (${memoryId}, ${encoded}) ON CONFLICT(memory_id) DO UPDATE SET parts = excluded.parts`
  })
  const append = Effect.fn('OptChat.append')(
    function* (memoryId: string, incoming: readonly MemoryInput[]) {
      yield* locks.withPermit(memoryId)(
        sql.withTransaction(
          Effect.gen(function* () {
            const state = yield* load(memoryId)
            const keys = new Set(state.messages.map((message) => message.sourceKey))
            let total = state.messages.length
            let parts = state.parts
            for (const message of incoming) {
              if (keys.has(message.sourceKey)) continue
              const id = total++
              yield* sql`INSERT INTO optchat_messages (memory_id, id, source_key, kind, text, date) VALUES (${memoryId}, ${id}, ${message.sourceKey}, ${message.kind}, ${message.text}, ${message.date})`
              keys.add(message.sourceKey)
              parts = fitView([...parts, { id, count: 1 }], total, state.nodes, budget)
            }
            yield* saveView(memoryId, parts)
          }),
        ),
      )
    },
    (effect) => effect.pipe(Effect.mapError(memoryError)),
  )

  const buildPass = Effect.fn('OptChat.buildPass')(
    function* (memoryId: string) {
      const state = yield* load(memoryId)
      const total = state.messages.length
      const first = state.parts.find((part) => !state.nodes.has(nodeKey(part)))?.id ?? total
      const ready: Array<{ part: MemoryPart; source: string; context: string; merge: boolean }> = []
      for (let count = 1; count <= total && ready.length < 8; count *= 2) {
        for (let id = 0; id + count <= total && ready.length < 8; id += count) {
          const part = { id, count }
          if (state.nodes.has(nodeKey(part)) || (count === 1 ? id : id + count) > first) continue
          const left = state.nodes.get(nodeKey({ id, count: count / 2 }))
          const right = state.nodes.get(nodeKey({ id: id + count / 2, count: count / 2 }))
          const message = state.messages[id]
          if (count > 1 && (left === undefined || right === undefined)) continue
          if (message === undefined) continue
          const source =
            count === 1
              ? `${message.kind}: ${message.text}`
              : `${left?.text.replaceAll('\n', ' ')}\n${right?.text.replaceAll('\n', ' ')}`
          const end = count === 1 ? id : id + count
          const context = `<chat>\n${state.parts
            .filter((item) => item.id + item.count <= end)
            .map((item) => state.nodes.get(nodeKey(item))?.text ?? '')
            .join('\n')}\n</chat>`
          ready.push({ part, source, context, merge: count > 1 })
        }
      }
      const built = yield* Effect.forEach(
        ready,
        (job) =>
          Effect.gen(function* () {
            const text =
              bytes(job.source) <= 512
                ? job.source
                : yield* compress({
                    ...job,
                    source: job.source,
                  })
            const node = { ...job.part, text } satisfies MemoryNode
            // Persist each successful call immediately, even if another job fails.
            yield* sql`INSERT OR IGNORE INTO optchat_nodes (memory_id, id, count, text) VALUES (${memoryId}, ${node.id}, ${node.count}, ${node.text})`
            return node
          }).pipe(Effect.mapError(memoryError), Effect.exit),
        { concurrency: 8 },
      )
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const result of built) {
            if (Exit.isSuccess(result)) state.nodes.set(nodeKey(result.value), result.value)
          }
          yield* saveView(memoryId, fitView(state.parts, total, state.nodes, budget))
        }),
      )
      for (const result of built)
        if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
      return built.length > 0
    },
    (effect) => effect.pipe(Effect.mapError(memoryError)),
  )
  const pump = Effect.fn('OptChat.pump')(function* (memoryId: string) {
    yield* locks.withPermit(memoryId)(
      Effect.gen(function* () {
        const totals = yield* sql<{
          total: number
        }>`SELECT COALESCE(MAX(id) + 1, 0) AS total FROM optchat_messages WHERE memory_id = ${memoryId}`
        const total = totals[0]?.total ?? 0
        const progress = yield* sql<{
          complete_total: number
        }>`SELECT complete_total FROM optchat_progress WHERE memory_id = ${memoryId}`
        if (progress[0]?.complete_total === total) return
        while (yield* buildPass(memoryId)) {
          /* Drain ready nodes in dependency order. */
        }
        yield* sql`INSERT INTO optchat_progress (memory_id, complete_total) VALUES (${memoryId}, ${total}) ON CONFLICT(memory_id) DO UPDATE SET complete_total = excluded.complete_total`
      }).pipe(Effect.mapError(memoryError)),
    )
  })
  const settle = Effect.fn('OptChat.settle')(function* (memoryId: string) {
    yield* pump(memoryId)
    const state = yield* load(memoryId)
    if (state.parts.some((part) => !state.nodes.has(nodeKey(part))))
      return yield* new PiDurableError({
        operation: 'optchat-settle',
        detail: 'Memory summaries are incomplete.',
      })
    return renderView(state.parts, state.nodes)
  })
  return {
    append,
    settle,
    pump,
    zoom: Effect.fn('OptChat.zoom')(
      function* (memoryId, id, count) {
        const totals = yield* sql<{
          total: number
        }>`SELECT COALESCE(MAX(id) + 1, 0) AS total FROM optchat_messages WHERE memory_id = ${memoryId}`
        if (!validRange(id, count, totals[0]?.total ?? 0)) return `No line ${id}+${count}.`
        if (count === 1) {
          const messages = yield* decodeMessages(
            yield* sql`SELECT id, source_key AS sourceKey, kind, text, date FROM optchat_messages WHERE memory_id = ${memoryId} AND id = ${id}`,
          )
          const message = messages[0]
          return message === undefined
            ? `No line ${id}+${count}.`
            : `${id}+0|${message.kind}: ${message.text}`
        }
        const half = count / 2
        const nodes = yield* decodeNodes(
          yield* sql`SELECT id, count, text FROM optchat_nodes WHERE memory_id = ${memoryId} AND count = ${half} AND id IN (${id}, ${id + half}) ORDER BY id`,
        )
        if (nodes.length !== 2) return `No summarized line ${id}+${count}.`
        return nodes.map((node) => `${nodeKey(node)}|${node.text}`).join('\n')
      },
      (effect) => effect.pipe(Effect.mapError(memoryError)),
    ),
    date: Effect.fn('OptChat.date')(
      function* (memoryId, id) {
        if (!Number.isSafeInteger(id) || id < 0) return 'No message.'
        const rows = yield* sql<{
          date: string
        }>`SELECT date FROM optchat_messages WHERE memory_id = ${memoryId} AND id = ${id}`
        return rows[0]?.date ?? 'No message.'
      },
      (effect) => effect.pipe(Effect.mapError(memoryError)),
    ),
  } satisfies OptChatMemory
})
