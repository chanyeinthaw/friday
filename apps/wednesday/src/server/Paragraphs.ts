import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'

const parser = unified().use(remarkParse).use(remarkGfm)

// Hold the unfinished last block, including lists and tables that can grow
// across blank lines. A final provider message always flushes the entire text.
export function completedMarkdown(source: string): string {
  const nodes = parser.parse(source).children
  let end = 0
  for (const [index, node] of nodes.entries()) {
    const offset = node.position?.end.offset
    const start = node.position?.start.offset
    if (offset === undefined || start === undefined) continue
    const suffix = source.slice(offset)
    if (index < nodes.length - 1) {
      end = offset
      continue
    }
    if (node.type === 'paragraph' && /^\r?\n[ \t]*\r?\n/.test(suffix)) end = offset
    if (node.type === 'code') {
      const block = source.slice(start, offset)
      const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(block)?.[1]
      if (fence && suffix.startsWith('\n')) {
        const lastLine = block.slice(block.lastIndexOf('\n') + 1)
        if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(lastLine)) end = offset
      }
    }
  }
  return source.slice(0, end)
}
