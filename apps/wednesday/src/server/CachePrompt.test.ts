import { expect, it } from 'vitest'
import { Prompt } from 'effect/ai'
import { cachePrompt } from './CachePrompt.ts'

const view = (count: number) =>
  `<chat>\n${Array.from({ length: count }, (_, id) => `${id}+1|decision ${id}`).join('\n')}\n</chat>`
const suffix = Prompt.make([{ role: 'user', content: 'What did we decide?' }]).content
const initialMessage = (count: number) => {
  const message = cachePrompt(view(count), suffix).content[0]
  if (message?.role !== 'user') throw new Error('Expected the initial user message')
  return message
}
it('keeps completed OptChat text blocks stable inside one initial user message', () => {
  const before = initialMessage(8)
  const after = initialMessage(9)
  expect(after.content.slice(0, 3)).toEqual(before.content.slice(0, 3))
  expect(cachePrompt(view(9), suffix).content.map((message) => message.role)).toEqual(['user'])
  expect(after.content.map((part) => (part.type === 'text' ? part.text : null))).toEqual([
    '<chat>\n',
    '0+1|decision 0\n1+1|decision 1\n2+1|decision 2\n3+1|decision 3\n',
    '4+1|decision 4\n5+1|decision 5\n6+1|decision 6\n7+1|decision 7\n',
    '8+1|decision 8\n</chat>\n',
    'What did we decide?',
  ])
  expect(after.content[2]?.options.anthropic).toEqual({ cacheControl: { type: 'ephemeral' } })
  expect(after.options.anthropic).toEqual({ cacheControl: { type: 'ephemeral' } })
})
it('marks the opening block until the first complete four-line block exists', () => {
  const message = initialMessage(3)
  expect(message.content[0]?.options.anthropic).toEqual({ cacheControl: { type: 'ephemeral' } })
  expect(message.content[1]?.options.anthropic).toBeUndefined()
})
it('preserves follow-up messages and steering outside the frozen initial message', () => {
  const conversation = Prompt.make([
    { role: 'user', content: 'What did we decide?' },
    { role: 'assistant', content: 'I will check.' },
    { role: 'user', content: 'Include the timestamp.' },
  ]).content
  const messages = cachePrompt(view(9), conversation).content
  expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
  expect(messages[1]).toEqual(conversation[1])
  expect(messages[2]?.content).toEqual(conversation[2]?.content)
  expect(messages[2]?.options.anthropic).toEqual({ cacheControl: { type: 'ephemeral' } })
})
it('keeps the exact memory and request text with a newline separating them', () => {
  const text = initialMessage(9)
    .content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('')
  expect(text).toBe(view(9) + '\nWhat did we decide?')
})
