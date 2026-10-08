/** OptChat's binary addressing and append-only view fold; sizes are UTF-8 bytes. */
export interface MemoryPart {
  readonly id: number
  readonly count: number
}
export interface MemoryNode extends MemoryPart {
  readonly text: string
}
export const summaryBytes = 512
export const viewBytes = 128_000
export const compactViewBytes = 32_000
export const bytes = (text: string): number => new TextEncoder().encode(text).length
export const nodeKey = (part: MemoryPart): string => `${part.id}+${part.count}`
export const validRange = (id: number, count: number, total: number): boolean =>
  Number.isSafeInteger(id) &&
  id >= 0 &&
  Number.isSafeInteger(count) &&
  count > 0 &&
  Number.isInteger(Math.log2(count)) &&
  id % count === 0 &&
  id + count <= total

export const fitView = (
  parts: readonly MemoryPart[],
  total: number,
  nodes: ReadonlyMap<string, MemoryNode>,
  budget = viewBytes,
): MemoryPart[] => {
  const view = [...parts]
  const sizeOf = (part: MemoryPart) =>
    bytes(
      `${nodeKey(part)}|${(nodes.get(nodeKey(part))?.text ?? '(not summarized yet: zoom it)').replaceAll('\n', ' ')}\n`,
    )
  let size = bytes('<chat>\n</chat>') + view.reduce((sum, part) => sum + sizeOf(part), 0)
  while (size > budget) {
    let best = -1
    let due = -1
    for (let index = 0; index < view.length - 1; index++) {
      const left = view[index]
      const right = view[index + 1]
      if (
        left === undefined ||
        right === undefined ||
        left.count !== right.count ||
        left.id % (left.count * 2) !== 0 ||
        right.id !== left.id + left.count
      )
        continue
      const parent = { id: left.id, count: left.count * 2 }
      // Age is measured from the pair's end; using its start churns old prefixes.
      const urgency = (total - (right.id + right.count - 1)) / left.count
      if (nodes.has(nodeKey(parent)) && urgency > due) {
        best = index
        due = urgency
      }
    }
    if (best < 0) break
    const left = view[best]
    const right = view[best + 1]
    if (left === undefined || right === undefined) break
    const parent = { id: left.id, count: left.count * 2 }
    size += sizeOf(parent) - sizeOf(left) - sizeOf(right)
    view.splice(best, 2, parent)
  }
  return view
}

/** Keep appending until the upper limit, then finish one batch down to half that limit. */
export const batchView = (
  parts: readonly MemoryPart[],
  total: number,
  nodes: ReadonlyMap<string, MemoryNode>,
  pending = false,
  limit = viewBytes,
) => {
  const sizeOf = (view: readonly MemoryPart[]) => bytes(renderView(view, nodes))
  const active = pending || sizeOf(parts) > limit
  const target = Math.floor(limit / 2)
  const view = active ? fitView(parts, total, nodes, target) : [...parts]
  return { parts: view, pending: active && sizeOf(view) > target }
}

export const renderView = (
  parts: readonly MemoryPart[],
  nodes: ReadonlyMap<string, MemoryNode>,
): string =>
  `<chat>\n${parts.map((part) => `${nodeKey(part)}|${(nodes.get(nodeKey(part))?.text ?? '(not summarized yet: zoom it)').replaceAll('\n', ' ')}`).join('\n')}\n</chat>`
