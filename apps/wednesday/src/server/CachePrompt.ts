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

/** Four-line messages keep old cache boundaries intact as the view grows. */
export const cachePrompt = (view: string, suffix: readonly Prompt.Message[]) => {
  const source = view.slice('<chat>\n'.length, -'\n</chat>'.length)
  const lines = source ? source.split('\n') : []
  const messages = [...Prompt.make([{ role: 'user', content: '<chat>\n' }]).content]
  for (let start = 0; start < lines.length; start += 4) {
    const complete = start + 4 <= lines.length
    const lastComplete = complete && start + 8 > lines.length
    const block = Prompt.make([
      {
        role: 'user',
        content: lines.slice(start, start + 4).join('\n') + '\n',
        options: lastComplete ? { anthropic: { cacheControl: { type: 'ephemeral' } } } : {},
      },
    ])
    messages.push(...block.content)
  }
  const end = suffix.at(-1)
  return Prompt.make([
    ...messages,
    { role: 'user', content: '</chat>' },
    ...suffix.slice(0, -1),
    ...(end ? [cacheEnd(end)] : []),
  ])
}
