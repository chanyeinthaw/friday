import { expect, it } from 'vitest'
import { compactionTask, shortenTask } from './OptChat.ts'
import { clipToolOutput, splitText } from './MessageSizing.ts'
import {
  batchView,
  bytes,
  renderView,
  validRange,
  nodeKey,
} from '../../../friday/src/optchat/OptChatTree.ts'

it('splits large Unicode messages without losing or breaking characters', () => {
  const text = '🪷'.repeat(30_001) + 'remember the end'
  const pages = splitText(text)
  expect(pages.join('')).toBe(text)
  expect(Array.from(pages[0] ?? '')).toHaveLength(30_000)
  expect(pages).toHaveLength(2)
})
it('clips only tool echoes to their head and tail', () => {
  const text = 'a'.repeat(15_000) + 'discard this middle' + 'z'.repeat(15_000)
  expect(clipToolOutput(text)).toBe('a'.repeat(15_000) + 'z'.repeat(15_000))
})
it('compaction retries show measured UTF-8 size and an intact 512-byte cut', () => {
  const reply = '🪷'.repeat(129)
  const task = shortenTask(reply)
  expect(task).toContain('516 bytes')
  expect(task).toContain('🪷'.repeat(128) + '| ← LIMIT')
  expect(task).not.toContain('\uFFFD')
  expect(bytes('🪷'.repeat(128))).toBe(512)
})
it('merge tasks identify their source range and ask for its details from context', () => {
  const task = compactionTask({ id: 40, count: 8, source: 'user: a\ntalk: b' })
  expect(task).toContain('40+4 and 44+4')
  expect(task).toContain('messages 40 to 47')
  expect(task).toContain('-'.repeat(512))
  expect(task).toContain('<input>\nuser: a\ntalk: b\n</input>')
})

it('batches a large view toward 64 KB while preserving complete aligned coverage', () => {
  const total = 1024
  const nodes = new Map<string, { id: number; count: number; text: string }>()
  for (let count = 1; count <= total; count *= 2)
    for (let id = 0; id + count <= total; id += count)
      nodes.set(nodeKey({ id, count }), { id, count, text: 'x'.repeat(200) })
  const parts = Array.from({ length: total }, (_, id) => ({ id, count: 1 }))
  expect(bytes(renderView(parts, nodes))).toBeGreaterThan(128_000)
  const fitted = batchView(parts, total, nodes)
  expect(fitted.pending).toBe(false)
  expect(bytes(renderView(fitted.parts, nodes))).toBeLessThanOrEqual(64_000)
  let end = 0
  for (const part of fitted.parts) {
    expect(part.id).toBe(end)
    expect(validRange(part.id, part.count, total)).toBe(true)
    end += part.count
  }
  expect(end).toBe(total)
  expect(batchView(fitted.parts, total, nodes).parts).toEqual(fitted.parts)
})
