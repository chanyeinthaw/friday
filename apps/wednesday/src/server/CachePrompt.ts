import { Prompt } from 'effect/ai'

const cacheEnd = (message: Prompt.Message) => {
  const options = {
    ...message.options,
    anthropic: { ...message.options.anthropic, cacheControl: { type: 'ephemeral' as const } },
  }
  switch (message.role) {
    case 'system':
      return Prompt.systemMessage({ content: message.content, options })
    case 'user':
      return Prompt.userMessage({ content: message.content, options })
    case 'assistant':
      return Prompt.assistantMessage({ content: message.content, options })
    case 'tool':
      return Prompt.toolMessage({ content: message.content, options })
  }
}

/** Match OptChat's single user message with stable four-line text blocks. */
export const cachePrompt = (view: string, suffix: readonly Prompt.Message[]) => {
  const source = view.slice('<chat>\n'.length, -'\n</chat>'.length)
  const lines = source ? source.split('\n') : []
  const whole = Math.floor(lines.length / 4)
  const marked = { anthropic: { cacheControl: { type: 'ephemeral' as const } } }
  const blocks = [Prompt.textPart({ text: '<chat>\n', options: whole === 0 ? marked : {} })]
  for (let index = 0; index < whole; index++) {
    blocks.push(
      Prompt.textPart({
        text: lines.slice(index * 4, (index + 1) * 4).join('\n') + '\n',
        options: index === whole - 1 ? marked : {},
      }),
    )
  }
  const tail = lines.slice(whole * 4)
  blocks.push(Prompt.textPart({ text: (tail.length ? tail.join('\n') + '\n' : '') + '</chat>\n' }))
  const first = suffix[0]
  const initial = Prompt.userMessage({
    content: [...blocks, ...(first?.role === 'user' ? first.content : [])],
    options: first?.role === 'user' ? first.options : {},
  })
  const messages = [initial, ...suffix.slice(first?.role === 'user' ? 1 : 0)]
  return Prompt.make(
    messages.map((message, index) =>
      suffix.length && index === messages.length - 1 ? cacheEnd(message) : message,
    ),
  )
}
