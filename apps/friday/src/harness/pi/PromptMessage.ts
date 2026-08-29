import type { InputMessage, MessageAuthor } from '@friday/contracts/conversation'

const metadataValue = (value: string | null): string =>
  value === null || value === '' ? '-' : value

const indentContinuationLines = (text: string): string => text.replaceAll('\n', '\n  ')

const renderParticipant = (author: MessageAuthor): string =>
  `p1 = ${metadataValue(author.mention)} | ${metadataValue(author.username)} | ${metadataValue(author.displayName)}`

/** Attributes one triggering channel message while leaving internal messages unchanged. */
export const renderPromptMessage = (message: InputMessage): string =>
  message.source === 'user' && message.author !== undefined
    ? `Participant:\n${renderParticipant(message.author)}\n\np1 [trigger]: ${indentContinuationLines(message.content.text)}`
    : message.content.text
