import { expect, it } from 'vitest'
import { memoryRanges } from './Memory.ts'

it('covers arbitrary intervals with aligned, disjoint nodes at every detail level', () => {
  for (const [start, end] of [
    [0, 0],
    [0, 257],
    [13, 173],
    [63, 65],
    [100, 101],
    [1, 1_000_003],
  ] as const) {
    for (let detail = 0; detail <= 3; detail++) {
      const parts = memoryRanges(start, end, detail)
      let cursor = start
      for (const part of parts) {
        expect(part.id).toBe(cursor)
        expect(part.id % part.count).toBe(0)
        expect(Number.isInteger(Math.log2(part.count))).toBe(true)
        cursor = part.id + part.count
      }
      expect(cursor).toBe(end)
      expect(parts.length).toBeLessThanOrEqual(40)
    }
  }
})
it('increases detail without changing scope and reaches originals in small ranges', () => {
  expect(memoryRanges(0, 128, 0)).toHaveLength(4)
  expect(memoryRanges(0, 128, 3)).toHaveLength(32)
  expect(memoryRanges(8, 12, 3)).toEqual([8, 9, 10, 11].map((id) => ({ id, count: 1 })))
})
