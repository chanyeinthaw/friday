import { Schema } from 'effect'
import { ChatMessage } from './protocol.ts'

const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const MemoryRange = Schema.Struct({
  id: Index,
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export interface MemoryRange extends Schema.Schema.Type<typeof MemoryRange> {}
export const MemoryTile = Schema.Struct({
  ...MemoryRange.fields,
  text: Schema.NullOr(Schema.String),
})
export interface MemoryTile extends Schema.Schema.Type<typeof MemoryTile> {}
export const MemorySnapshot = Schema.Struct({
  total: Index,
  start: Index,
  end: Index,
  tiles: Schema.Array(MemoryTile),
})
export interface MemorySnapshot extends Schema.Schema.Type<typeof MemorySnapshot> {}
export const MemoryOriginal = Schema.NullOr(ChatMessage)
export const MemoryQuery = Schema.Struct({
  start: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  end: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  detail: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: 3 }),
  ),
})
export interface MemoryQuery extends Schema.Schema.Type<typeof MemoryQuery> {}

/** Cover an arbitrary interval with aligned tree nodes, then split its largest regions. */
export function memoryRanges(start: number, end: number, detail: number): MemoryRange[] {
  const parts: MemoryRange[] = []
  for (let id = start; id < end;) {
    let count = 1
    while (id % (count * 2) === 0 && count * 2 <= end - id) count *= 2
    parts.push({ id, count })
    id += count
  }
  const target = Math.max(parts.length, 4 * 2 ** detail)
  while (parts.length < target) {
    const largest = parts.reduce(
      (best, part, index) => (part.count > (parts[best]?.count ?? 1) ? index : best),
      -1,
    )
    if (largest < 0) break
    const part = parts[largest]
    if (!part || part.count === 1) break
    const count = part.count / 2
    parts.splice(largest, 1, { id: part.id, count }, { id: part.id + count, count })
  }
  return parts
}
