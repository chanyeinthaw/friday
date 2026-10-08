import * as Exit from 'effect/Exit'
import * as Queue from 'effect/Queue'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as PartitionedSemaphore from 'effect/PartitionedSemaphore'
import { PiDurableError } from '../harness/pi/PiDurableError.ts'
import {
  bytes,
  batchView,
  compactViewBytes,
  nodeKey,
  renderView,
  validRange,
  type MemoryNode,
  type MemoryPart,
} from './OptChatTree.ts'
import type { Compress } from './OptChatCompactor.ts'
import { OptChatPrefix, prefixCodec } from './OptChatPrefix.ts'

const decodePrefix = Schema.decodeUnknownEffect(prefixCodec)
const parsePrefix = Schema.decodeUnknownEffect(OptChatPrefix)
const encodePrefix = Schema.encodeEffect(prefixCodec)

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
  readonly setPrefix: (
    memoryId: string,
    prefix: OptChatPrefix,
  ) => Effect.Effect<void, PiDurableError>
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
  const pumps = yield* PartitionedSemaphore.make<string>({ permits: 1 })
  yield* sql`CREATE TABLE IF NOT EXISTS optchat_messages (memory_id TEXT NOT NULL, id INTEGER NOT NULL, source_key TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, date TEXT NOT NULL, PRIMARY KEY (memory_id, id), UNIQUE(memory_id, source_key))`
  yield* sql`CREATE TABLE IF NOT EXISTS optchat_nodes (memory_id TEXT NOT NULL, id INTEGER NOT NULL, count INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(memory_id, id, count))`
  yield* sql`CREATE TABLE IF NOT EXISTS optchat_progress (memory_id TEXT PRIMARY KEY, complete_total INTEGER NOT NULL)`
  yield* sql`CREATE TABLE IF NOT EXISTS optchat_views (memory_id TEXT PRIMARY KEY, parts TEXT NOT NULL)`
  yield* sql`CREATE TABLE IF NOT EXISTS optchat_cache_views (memory_id TEXT PRIMARY KEY, pending INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, compact_parts TEXT NOT NULL DEFAULT '[]', compact_pending INTEGER NOT NULL DEFAULT 0, compact_revision INTEGER NOT NULL DEFAULT -1)`
  yield* sql`CREATE TABLE IF NOT EXISTS optchat_prefixes (memory_id TEXT PRIMARY KEY, prefix TEXT NOT NULL)`
  const setPrefix = Effect.fn('OptChat.setPrefix')(
    function* (memoryId: string, prefix: OptChatPrefix) {
      const value = yield* parsePrefix(prefix)
      const encoded = yield* encodePrefix(value)
      yield* sql`INSERT INTO optchat_prefixes (memory_id, prefix) VALUES (${memoryId}, ${encoded}) ON CONFLICT(memory_id) DO UPDATE SET prefix = excluded.prefix WHERE prefix != excluded.prefix`
    },
    (effect) => effect.pipe(Effect.mapError(memoryError)),
  )
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
      const cacheRows = yield* sql<{
        pending: number
        revision: number
        compact_parts: string
        compact_pending: number
        compact_revision: number
      }>`SELECT * FROM optchat_cache_views WHERE memory_id = ${memoryId}`
      const cache = cacheRows[0]
      return {
        messages,
        nodes,
        parts,
        pending: cache?.pending === 1,
        revision: cache?.revision ?? 0,
        compactParts: cache === undefined ? [] : yield* decodeParts(cache.compact_parts),
        compactPending: cache?.compact_pending === 1,
        compactRevision: cache?.compact_revision ?? -1,
      }
    },
    (effect) => effect.pipe(Effect.mapError(memoryError)),
  )
  const saveView = Effect.fn('OptChat.saveView')(function* (
    memoryId: string,
    parts: readonly MemoryPart[],
    pending: boolean,
    merged: boolean,
  ) {
    const encoded = yield* encodeParts(parts)
    yield* sql`INSERT INTO optchat_views (memory_id, parts) VALUES (${memoryId}, ${encoded}) ON CONFLICT(memory_id) DO UPDATE SET parts = excluded.parts`
    yield* sql`INSERT INTO optchat_cache_views (memory_id, pending, revision) VALUES (${memoryId}, ${Number(pending)}, ${Number(merged)}) ON CONFLICT(memory_id) DO UPDATE SET pending = excluded.pending, revision = revision + excluded.revision`
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
            let pending = state.pending
            let merged = false
            for (const message of incoming) {
              if (keys.has(message.sourceKey)) continue
              const id = total++
              yield* sql`INSERT INTO optchat_messages (memory_id, id, source_key, kind, text, date) VALUES (${memoryId}, ${id}, ${message.sourceKey}, ${message.kind}, ${message.text}, ${message.date})`
              keys.add(message.sourceKey)
              const appended = [...parts, { id, count: 1 }]
              const batch = batchView(appended, total, state.nodes, pending, budget)
              merged ||= batch.parts.length < appended.length
              parts = batch.parts
              pending = batch.pending
            }
            yield* saveView(memoryId, parts, pending, merged)
          }),
        ),
      )
    },
    (effect) => effect.pipe(Effect.mapError(memoryError)),
  )

  const prepareCompactView = Effect.fn('OptChat.prepareCompactView')(function* (
    memoryId: string,
    state: Effect.Success<ReturnType<typeof load>>,
    first: number,
  ) {
    // The compactor has its own persisted sawtooth, reset only when the main view merges.
    const reset = state.compactRevision !== state.revision
    let compactParts = reset ? [] : state.compactParts
    const covered = compactParts.at(-1)
    const next = covered === undefined ? 0 : covered.id + covered.count
    compactParts = [
      ...compactParts,
      ...state.parts.filter((part) => part.id >= next && part.id + part.count <= first),
    ]
    const compact = batchView(
      compactParts,
      state.messages.length,
      state.nodes,
      reset || state.compactPending,
      compactViewBytes,
    )
    const encoded = yield* encodeParts(compact.parts)
    yield* sql`INSERT INTO optchat_cache_views (memory_id, compact_parts, compact_pending, compact_revision) VALUES (${memoryId}, ${encoded}, ${Number(compact.pending)}, ${state.revision}) ON CONFLICT(memory_id) DO UPDATE SET compact_parts = excluded.compact_parts, compact_pending = excluded.compact_pending, compact_revision = excluded.compact_revision`
    return compact.parts
  })

  const readyJobs = Effect.fn('OptChat.readyJobs')(
    function* (memoryId: string, blocked: ReadonlySet<string>, capacity: number) {
      const state = yield* load(memoryId)
      const total = state.messages.length
      const first = state.parts.find((part) => !state.nodes.has(nodeKey(part)))?.id ?? total
      const compactParts = yield* prepareCompactView(memoryId, state, first)
      const ready: Array<{ part: MemoryPart; source: string; context: string; merge: boolean }> = []
      for (let count = 1; count <= total && ready.length < capacity; count *= 2) {
        for (let id = 0; id + count <= total && ready.length < capacity; id += count) {
          const part = { id, count }
          if (
            state.nodes.has(nodeKey(part)) ||
            blocked.has(nodeKey(part)) ||
            (count === 1 ? id : id + count) > first
          )
            continue
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
          const context = renderView(
            compactParts.filter((item) => item.id + item.count <= end),
            state.nodes,
          )
          ready.push({ part, source, context, merge: count > 1 })
        }
      }
      return ready
    },
    (effect, memoryId) =>
      locks.withPermit(memoryId)(sql.withTransaction(effect)).pipe(Effect.mapError(memoryError)),
  )
  const buildNode = Effect.fn('OptChat.buildNode')(
    function* (memoryId: string, job: Effect.Success<ReturnType<typeof readyJobs>>[number]) {
      const prefixes = yield* sql<{
        prefix: string
      }>`SELECT prefix FROM optchat_prefixes WHERE memory_id = ${memoryId}`
      const prefix = prefixes[0] === undefined ? undefined : yield* decodePrefix(prefixes[0].prefix)
      const text = bytes(job.source) <= 512 ? job.source : yield* compress({ ...job, prefix })
      const node = { ...job.part, text } satisfies MemoryNode
      // Persist and refit each successful node even if a sibling job fails.
      yield* locks.withPermit(memoryId)(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT OR IGNORE INTO optchat_nodes (memory_id, id, count, text) VALUES (${memoryId}, ${node.id}, ${node.count}, ${node.text})`
            const current = yield* load(memoryId)
            const batch = batchView(
              current.parts,
              current.messages.length,
              current.nodes,
              current.pending,
              budget,
            )
            yield* saveView(
              memoryId,
              batch.parts,
              batch.pending,
              batch.parts.length < current.parts.length,
            )
          }),
        ),
      )
    },
    (effect) => effect.pipe(Effect.mapError(memoryError)),
  )
  const drain = Effect.fn('OptChat.drain')((memoryId: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const completions = yield* Queue.make<{
          key: string
          result: Exit.Exit<void, PiDurableError>
        }>()
        const busy = new Set<string>()
        const failed = new Set<string>()
        let failure: Exit.Exit<void, PiDurableError> | undefined
        while (true) {
          const jobs = yield* readyJobs(memoryId, new Set([...busy, ...failed]), 8 - busy.size)
          for (const job of jobs) {
            const key = nodeKey(job.part)
            busy.add(key)
            yield* buildNode(memoryId, job).pipe(
              Effect.exit,
              Effect.flatMap((result) => Queue.offer(completions, { key, result })),
              Effect.forkChild,
            )
          }
          if (busy.size === 0) break
          const completed = yield* Queue.take(completions)
          busy.delete(completed.key)
          if (Exit.isFailure(completed.result)) {
            failed.add(completed.key)
            failure = completed.result
          }
        }
        if (failure !== undefined && Exit.isFailure(failure))
          return yield* Effect.failCause(failure.cause)
      }),
    ),
  )
  const pump = Effect.fn('OptChat.pump')(function* (memoryId: string) {
    yield* pumps.withPermit(memoryId)(
      Effect.gen(function* () {
        const totals = yield* sql<{
          total: number
        }>`SELECT COALESCE(MAX(id) + 1, 0) AS total FROM optchat_messages WHERE memory_id = ${memoryId}`
        const total = totals[0]?.total ?? 0
        const progress = yield* sql<{
          complete_total: number
        }>`SELECT complete_total FROM optchat_progress WHERE memory_id = ${memoryId}`
        if (progress[0]?.complete_total === total) return
        yield* drain(memoryId)
        // Appends may arrive during a pass; the original total remains a safe progress watermark.
        yield* sql`INSERT INTO optchat_progress (memory_id, complete_total) VALUES (${memoryId}, ${total}) ON CONFLICT(memory_id) DO UPDATE SET complete_total = excluded.complete_total`
      }).pipe(Effect.mapError(memoryError)),
    )
  })
  const settle = Effect.fn('OptChat.settle')(function* (memoryId: string) {
    const before = yield* load(memoryId)
    if (before.parts.every((part) => before.nodes.has(nodeKey(part))))
      return renderView(before.parts, before.nodes)
    const waitForView = Effect.gen(function* () {
      while (true) {
        const state = yield* load(memoryId)
        if (state.parts.every((part) => state.nodes.has(nodeKey(part))))
          return renderView(state.parts, state.nodes)
        yield* Effect.sleep('100 millis')
      }
    })
    return yield* Effect.raceFirst(
      waitForView,
      pump(memoryId).pipe(
        Effect.matchEffect({
          onSuccess: () => waitForView,
          onFailure: (cause) =>
            Effect.gen(function* () {
              const state = yield* load(memoryId)
              if (state.parts.every((part) => state.nodes.has(nodeKey(part))))
                return renderView(state.parts, state.nodes)
              return yield* Effect.fail(cause)
            }),
        }),
      ),
    )
  })
  return {
    setPrefix,
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
