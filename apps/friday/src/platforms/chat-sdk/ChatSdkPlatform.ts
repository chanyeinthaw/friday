import type { ConversationBinding, PlatformConnectionId } from '@friday/contracts/conversation'
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

export interface ChatSdkPlatformOptions {
  readonly maxMessageLength?: number
  readonly setConversationTitle?: PlatformAdapter<ChatSdkPublicationError>['setConversationTitle']
  readonly setAgentActivity?: PlatformAdapter<ChatSdkPublicationError>['setAgentActivity']
  readonly searchMessages?: PlatformAdapter<ChatSdkPublicationError>['searchMessages']
  /** Retained for lifecycle compatibility; durable working messages do not refresh typing. */
  readonly typingRefreshInterval?: unknown
}

const DiscordMessageLimit = 2_000

/** Splits at paragraph, line, or word boundaries before falling back to a hard limit. */
export const splitMessage = (text: string, maxLength: number): ReadonlyArray<string> => {
  if (text.length <= maxLength) return [text]
  const chunks: Array<string> = []
  let remaining = text
  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength)
    const minimumSoftBreak = Math.floor(maxLength / 2)
    const paragraph = window.lastIndexOf('\n\n')
    const line = window.lastIndexOf('\n')
    const word = window.lastIndexOf(' ')
    let boundary =
      paragraph >= minimumSoftBreak
        ? paragraph + 2
        : line >= minimumSoftBreak
          ? line + 1
          : word >= minimumSoftBreak
            ? word + 1
            : maxLength
    const previous = remaining.charCodeAt(boundary - 1)
    const next = remaining.charCodeAt(boundary)
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      boundary -= 1
    }
    chunks.push(remaining.slice(0, boundary))
    remaining = remaining.slice(boundary)
  }
  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}

const publicationError = (operation: ChatSdkPublicationError['operation'], cause: unknown) =>
  new ChatSdkPublicationError({ operation, cause })

export const makeChatSdkPlatform = Effect.fn('makeChatSdkPlatform')(
  (
    connectionId: PlatformConnectionId,
    kind: ConversationBinding['platform'],
    chat: ChatSdkPublicationSource,
    options: ChatSdkPlatformOptions = {},
  ): Effect.Effect<PlatformAdapter<ChatSdkPublicationError>> =>
    Effect.sync(() => {
      const working = new Map<string, ChatSdkSentMessageSource>()
      const maxMessageLength =
        options.maxMessageLength ?? (kind === 'discord' ? DiscordMessageLimit : undefined)
      const threadSource = (key: string): ChatSdkThreadSource => {
        const thread = chat.thread(key)
        return {
          post: async (text) => (await thread.post(text)) as ChatSdkSentMessageSource,
          messages: thread.messages,
          createSentMessageFromMessage: (message) =>
            thread.createSentMessageFromMessage(message as never) as ChatSdkSentMessageSource,
        }
      }
      const threadFor = (binding: ConversationBinding): ChatSdkThreadSource =>
        threadSource(String(binding.conversationId))
      const latestMessageId = async (thread: ChatSdkThreadSource): Promise<string | undefined> => {
        for await (const message of thread.messages) return message.id
        return undefined
      }
      const chunksFor = (text: string): ReadonlyArray<string> =>
        maxMessageLength === undefined ? [text] : splitMessage(text, maxMessageLength)
      const postAll = async (thread: ChatSdkThreadSource, text: string): Promise<void> => {
        for (const chunk of chunksFor(text)) await thread.post(chunk)
      }

      return {
        connectionId,
        kind,
        publish: (publication: PlatformPublication) =>
          Effect.tryPromise({
            try: () => postAll(threadFor(publication.binding), publication.text),
            catch: (cause) => publicationError('publish', cause),
          }),
        acknowledge: (target) =>
          Effect.tryPromise({
            try: async () => {
              const react = async (key: string): Promise<boolean> => {
                const candidate = threadSource(key)
                for await (const message of candidate.messages) {
                  if (message.id !== target.messageId) continue
                  await candidate.createSentMessageFromMessage(message).addReaction(emoji.eyes)
                  return true
                }
                return false
              }
              const isThreadStarter = String(target.binding.conversationId).endsWith(
                `:${target.messageId}`,
              )
              if (isThreadStarter) {
                if (await react(String(target.binding.channelId))) return
              } else if (await react(String(target.binding.conversationId))) {
                return
              }
              throw new Error(`Message '${target.messageId}' was not found for acknowledgement.`)
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
              const chunks = chunksFor(message.text)
              const first = chunks[0] ?? ''
              if (!sent) {
                await postAll(thread, message.text)
                return
              }
              if ((await latestMessageId(thread)) === sent.id) {
                await sent.edit(first)
                for (const chunk of chunks.slice(1)) await thread.post(chunk)
                return
              }
              await sent.delete()
              await postAll(thread, message.text)
            },
            catch: (cause) => publicationError('finalize-working', cause),
          }),
        discardWorking: (binding) =>
          Effect.tryPromise({
            try: async () => {
              const sent = working.get(String(binding.conversationId))
              working.delete(String(binding.conversationId))
              if (sent) await sent.delete()
            },
            catch: (cause) => publicationError('discard-working', cause),
          }),
        setConversationTitle: options.setConversationTitle ?? (() => Effect.void),
        setAgentActivity: options.setAgentActivity ?? (() => Effect.void),
        searchMessages:
          options.searchMessages ??
          (() => Effect.succeed({ messages: [], scannedCount: 0, truncated: false })),
        withTyping: (_binding, effect) => effect,
      }
    }),
)
