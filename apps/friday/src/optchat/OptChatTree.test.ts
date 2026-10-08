import { describe, expect, it } from 'vitest'
import { batchView, bytes, fitView, nodeKey, renderView, type MemoryNode } from './OptChatTree.ts'

describe('OptChat view', () => {
  it('merges the recent pair at T=10 rather than rewriting the old prefix', () => {
    const parts = [
      { id: 0, count: 4 },
      { id: 4, count: 4 },
      { id: 8, count: 1 },
      { id: 9, count: 1 },
    ]
    const nodes = new Map(
      [...parts, { id: 0, count: 8 }, { id: 8, count: 2 }].map((part) => [
        nodeKey(part),
        { ...part, text: 'x'.repeat(20) },
      ]),
    )
    expect(fitView(parts, 10, nodes, 95)).toEqual([
      { id: 0, count: 4 },
      { id: 4, count: 4 },
      { id: 8, count: 2 },
    ])
  })
  it('keeps the prefix until the upper limit and finishes a deferred batch', () => {
    const parts = Array.from({ length: 4 }, (_, id) => ({ id, count: 1 }))
    const nodes = new Map(parts.map((part) => [nodeKey(part), { ...part, text: 'x'.repeat(40) }]))
    expect(batchView(parts, 4, nodes, false, 200)).toEqual({ parts, pending: false })
    const appended = [...parts, { id: 4, count: 1 }]
    nodes.set('4+1', { id: 4, count: 1, text: 'x'.repeat(40) })
    const deferred = batchView(appended, 5, nodes, false, 200)
    expect(deferred.pending).toBe(true)
    expect(deferred.parts).toEqual(appended)
    nodes.set('0+2', { id: 0, count: 2, text: 'pair' })
    nodes.set('2+2', { id: 2, count: 2, text: 'pair' })
    const finished = batchView(deferred.parts, 5, nodes, deferred.pending, 200)
    expect(finished.pending).toBe(false)
    expect(bytes(renderView(finished.parts, nodes))).toBeLessThanOrEqual(100)
    expect(batchView(finished.parts, 5, nodes, false, 200).parts).toEqual(finished.parts)
  })
  it('merges the oldest due siblings and preserves coverage without splitting', () => {
    const nodes = new Map<string, MemoryNode>()
    for (let id = 0; id < 8; id++)
      nodes.set(nodeKey({ id, count: 1 }), { id, count: 1, text: 'detail'.repeat(6) })
    for (let id = 0; id < 8; id += 2)
      nodes.set(nodeKey({ id, count: 2 }), { id, count: 2, text: `pair ${id}` })
    nodes.set('0+4', { id: 0, count: 4, text: 'older decisions' })
    const view = fitView(
      Array.from({ length: 8 }, (_, id) => ({ id, count: 1 })),
      8,
      nodes,
      110,
    )
    expect(view[0]).toEqual({ id: 0, count: 4 })
    expect(
      view.flatMap((part) => Array.from({ length: part.count }, (_, index) => part.id + index)),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(fitView(view, 8, nodes, 1000)).toEqual(view)
    expect(renderView(view, nodes)).toContain('0+4|older decisions')
  })
  it('waits for built parents rather than dropping history to meet the budget', () => {
    const nodes = new Map([['0+1', { id: 0, count: 1, text: 'unmerged detail' }]])
    expect(
      fitView(
        [
          { id: 0, count: 1 },
          { id: 1, count: 1 },
        ],
        2,
        nodes,
        1,
      ),
    ).toEqual([
      { id: 0, count: 1 },
      { id: 1, count: 1 },
    ])
  })
})
