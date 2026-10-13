import { describe, expect, it } from 'vitest'
import { completedMarkdown } from './Paragraphs.ts'

describe('completed Markdown streaming', () => {
  it('holds unfinished paragraphs and reveals a completed paragraph', () => {
    expect(completedMarkdown('Partial')).toBe('')
    expect(completedMarkdown('First.\n\nPartial')).toBe('First.')
    expect(completedMarkdown('First.\n\n')).toBe('First.')
    expect(completedMarkdown('First.\n\nSecond.\n\nThird')).toBe('First.\n\nSecond.')
  })
  it('keeps blank lines inside unclosed code fences hidden', () => {
    const code = 'Before.\n\n```ts\nconst x = 1\n\nconst y = 2'
    expect(completedMarkdown(code)).toBe('Before.')
    expect(completedMarkdown(`${code}\n\`\`\`\n`)).toBe(`${code}\n\`\`\``)
    expect(completedMarkdown('~~~ts\nx\n```\n\n')).toBe('')
  })
  it('holds tables and loose lists until the next block establishes their end', () => {
    const table = '| Name | Value |\n| --- | --- |\n| A | B |\n\n'
    expect(completedMarkdown(table)).toBe('')
    expect(completedMarkdown(`${table}Next`)).toBe(table.trimEnd())
    const list = '- First\n\n- Second\n\n'
    expect(completedMarkdown(list)).toBe('')
    expect(completedMarkdown(`${list}Next`)).toBe(list.trimEnd())
  })
  it('handles CRLF paragraphs without revealing the next partial block', () => {
    expect(completedMarkdown('First.\r\n\r\nSecond')).toBe('First.')
  })
})
