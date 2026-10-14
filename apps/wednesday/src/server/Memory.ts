import { Effect } from 'effect'
import { memoryRanges, type MemoryQuery } from '../shared/Memory.ts'
import { Storage } from './Storage.ts'
import { failure } from './errors.ts'

export const browseMemory = Effect.fn('Memory.browse')(function* (
  userId: string,
  query: MemoryQuery,
) {
  const storage = yield* Storage
  const { total } = yield* storage.memory(userId)
  const start = query.start ?? 0
  const end = query.end ?? total
  if (start > end || end > total || !Number.isSafeInteger(start) || !Number.isSafeInteger(end))
    return yield* failure('This message range is unavailable.')
  const parts = memoryRanges(start, end, query.detail)
  const nodes = yield* storage.memoryNodes(userId, parts)
  const texts = new Map(nodes.map((node) => [`${node.id}:${node.count}`, node.text]))
  return {
    total,
    start,
    end,
    tiles: parts.map((part) => ({
      id: part.id,
      count: part.count,
      text: texts.get(`${part.id}:${part.count}`) ?? null,
    })),
  }
})
export const readMemoryOriginal = Effect.fn('Memory.original')(function* (
  userId: string,
  id: number,
) {
  const storage = yield* Storage
  return yield* storage.message(userId, id)
})
