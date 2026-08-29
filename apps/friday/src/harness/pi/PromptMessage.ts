import type { InputMessage, MessageAuthor } from '@friday/contracts/conversation'

const metadataValue = (value: string | null): string =>
  value === null || value === '' ? '(none)' : value

const renderAuthor = (author: MessageAuthor): string =>
  [
    '<channel-participant>',
    `platform-user-id: ${author.platformUserId}`,
    `username: ${metadataValue(author.username)}`,
    `display-name: ${metadataValue(author.displayName)}`,
    '</channel-participant>',
  ].join('\n')

/** Attributes channel input while leaving trusted internal agent/system messages unchanged. */
export const renderPromptMessage = (message: InputMessage): string =>
  message.source === 'user' && message.author !== undefined
    ? `${renderAuthor(message.author)}\n\n<message>\n${message.content.text}\n</message>`
    : message.content.text
