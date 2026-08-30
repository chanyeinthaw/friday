import type { ContextMessage, InputMessage, MessageAuthor } from '@friday/contracts/conversation'

const metadataValue = (value: string | null): string =>
  value === null || value === '' ? '-' : value

const indentContinuationLines = (text: string): string => text.replaceAll('\n', '\n  ')

const authorKey = (author: MessageAuthor): string => author.platformUserId

const renderAttributedConversation = (
  trigger: InputMessage & { readonly author: MessageAuthor },
  context: ReadonlyArray<ContextMessage>,
): string => {
  const participants = new Map<string, { readonly alias: string; readonly author: MessageAuthor }>()
  const aliasFor = (author: MessageAuthor): string => {
    const key = authorKey(author)
    const existing = participants.get(key)
    if (existing) return existing.alias
    const alias = `p${participants.size + 1}`
    participants.set(key, { alias, author })
    return alias
  }
  for (const message of context) aliasFor(message.author)
  const triggerAlias = aliasFor(trigger.author)
  const roster = Array.from(
    participants.values(),
    ({ alias, author }) =>
      `${alias} = ${metadataValue(author.mention)} | ${metadataValue(author.username)} | ${metadataValue(author.displayName)}`,
  ).join('\n')
  const transcript = context.map(
    (message) =>
      `${aliasFor(message.author)} [context]: ${indentContinuationLines(message.content.text)}`,
  )
  return `Participants:\n${roster}\n\n${[...transcript, `${triggerAlias} [trigger]: ${indentContinuationLines(trigger.content.text)}`].join('\n')}`
}

/** Attributes one triggering channel message while leaving internal messages unchanged. */
export const renderPromptMessage = (message: InputMessage): string => {
  if (message.source !== 'user' || message.author === undefined) return message.content.text
  return renderAttributedConversation({ ...message, author: message.author }, message.context ?? [])
}
