import type { ConversationBinding } from '@friday/contracts/conversation'
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion -- Chat SDK's concrete generic message types are adapted to the narrow capabilities Friday uses. */

import { emoji, type EmojiValue } from 'chat'
import * as Effect from 'effect/Effect'

import type { PlatformAdapter, PlatformPublication } from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from './Errors.ts'

export interface ChatSdkMessageSource {
  readonly id: string
}

export interface ChatSdkSentMessageSource extends ChatSdkMessageSource {
  readonly addReaction: (emoji: EmojiValue | string) => Promise<void>
  readonly delete: () => Promise<void>
  readonly edit: (text: string) => Promise<ChatSdkSentMessageSource>
}

interface ChatSdkThreadSource {
  readonly post: (text: string) => Promise<ChatSdkSentMessageSource>
  readonly messages: AsyncIterable<ChatSdkMessageSource>
  readonly createSentMessageFromMessage: (message: ChatSdkMessageSource) => ChatSdkSentMessageSource
}

export interface ChatSdkPublicationSource {
  readonly thread: (threadId: string) => {
    readonly post: (text: string) => Promise<unknown>
    readonly messages: AsyncIterable<{ readonly id: string }>
    readonly createSentMessageFromMessage: (message: never) => unknown
  }
}

export interface ChatSdkPlatformOptions {}

const publicationError = (operation: ChatSdkPublicationError['operation'], cause: unknown) =>
  new ChatSdkPublicationError({ operation, cause })

export const makeChatSdkPlatform = Effect.fn('makeChatSdkPlatform')(
  (
    kind: ConversationBinding['platform'],
    chat: ChatSdkPublicationSource,
    _options: ChatSdkPlatformOptions = {},
  ): Effect.Effect<PlatformAdapter<ChatSdkPublicationError>> =>
    Effect.sync(() => {
      const working = new Map<string, ChatSdkSentMessageSource>()
      const threadFor = (binding: ConversationBinding): ChatSdkThreadSource => {
        const thread = chat.thread(String(binding.conversationId))
        return {
          post: async (text) => (await thread.post(text)) as ChatSdkSentMessageSource,
          messages: thread.messages,
          createSentMessageFromMessage: (message) =>
            thread.createSentMessageFromMessage(message as never) as ChatSdkSentMessageSource,
        }
      }
      const latestMessageId = async (thread: ChatSdkThreadSource): Promise<string | undefined> => {
        for await (const message of thread.messages) return message.id
        return undefined
      }

      return {
        kind,
        publish: (publication: PlatformPublication) =>
          Effect.tryPromise({
            try: () => threadFor(publication.binding).post(publication.text),
            catch: (cause) => publicationError('publish', cause),
          }).pipe(Effect.asVoid),
        acknowledge: (target) =>
          Effect.tryPromise({
            try: async () => {
              const thread = threadFor(target.binding)
              for await (const message of thread.messages) {
                if (message.id !== target.messageId) continue
                await thread.createSentMessageFromMessage(message).addReaction(emoji.check)
                return
              }
              throw new Error(`Message '${target.messageId}' was not found in the thread.`)
            },
            catch: (cause) => publicationError('acknowledge', cause),
          }),
        beginWorking: (message) =>
          Effect.tryPromise({
            try: async () => {
              const sent = await threadFor(message.binding).post(message.text)
              working.set(String(message.binding.conversationId), sent)
            },
            catch: (cause) => publicationError('begin-working', cause),
          }),
        updateWorking: (message) =>
          Effect.tryPromise({
            try: async () => {
              const sent = working.get(String(message.binding.conversationId))
              if (!sent) return
              working.set(String(message.binding.conversationId), await sent.edit(message.text))
            },
            catch: (cause) => publicationError('update-working', cause),
          }),
        finalizeWorking: (message) =>
          Effect.tryPromise({
            try: async () => {
              const key = String(message.binding.conversationId)
              const thread = threadFor(message.binding)
              const sent = working.get(key)
              working.delete(key)
              if (!sent) {
                await thread.post(message.text)
                return
              }
              if ((await latestMessageId(thread)) === sent.id) {
                await sent.edit(message.text)
                return
              }
              await sent.delete()
              await thread.post(message.text)
            },
            catch: (cause) => publicationError('finalize-working', cause),
          }),
        withTyping: (_binding, effect) => effect,
      }
    }),
)
