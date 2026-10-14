import type { PendingMessage } from './protocol.ts'

// Quotes remain user-supplied context, never an assistant turn.
export const replyContext = (message: Pick<PendingMessage, 'text' | 'reply'>) =>
  message.reply
    ? `Replying to ${message.reply.kind === 'user' ? 'my message' : 'your response'} (message ${message.reply.id}):\n${message.reply.text
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}\n\n${message.text}`
    : message.text
