import { describe, expect, it } from 'vitest'
import { fitView, nodeKey, renderView, type MemoryNode } from './OptChatTree.ts'

describe('OptChat view', () => {
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
