import { expect, it } from 'vitest'
import { Prompt } from 'effect/ai'
import { cachePrompt } from './CachePrompt.ts'

const view = (count: number) =>
  `<chat>\n${Array.from({ length: count }, (_, id) => `${id}+1|decision ${id}`).join('\n')}\n</chat>`
const suffix = Prompt.make([{ role: 'user', content: 'What did we decide?' }]).content
it('preserves completed memory messages and cache boundaries when new lines arrive', () => {
  const before = cachePrompt(view(8), suffix).content
  const after = cachePrompt(view(9), suffix).content
  expect(after.slice(0, 3)).toEqual(before.slice(0, 3))
  expect(after.map((message) => message.role)).toEqual([
    'user',
    'user',
    'user',
    'user',
    'user',
    'user',
  ])
  expect(after.at(-1)?.options.anthropic).toEqual({ cacheControl: { type: 'ephemeral' } })
})
it('keeps the exact memory text and request text without duplicating or dropping either', () => {
  const messages = cachePrompt(view(9), suffix).content
  const text = messages
    .flatMap((message) =>
      message.role === 'user'
        ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
        : [],
    )
    .join('')
  expect(text).toBe(view(9) + 'What did we decide?')
})
