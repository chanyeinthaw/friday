import type { ConversationBinding, PlatformConnectionId } from '@friday/contracts/conversation'
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion -- Chat SDK's concrete generic message types are adapted to the narrow capabilities Friday uses. */

import { emoji, type EmojiValue } from 'chat'
import * as Effect from 'effect/Effect'

import type { PlatformAdapter, PlatformPublication } from '../PlatformAdapter.ts'
import {
  formatDiscordWorkingStatus,
  makeWorkingMessageLifecycle,
  splitMessage,
} from '../working-message/WorkingMessageLifecycle.ts'
import { ChatSdkPublicationError } from './Errors.ts'

export { splitMessage }

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
      const workingLifecycle = makeWorkingMessageLifecycle<
        ChatSdkSentMessageSource,
        ChatSdkPublicationError
      >({
        chunksFor,
        post: (binding, text) => threadFor(binding).post(text),
        edit: (handle, _binding, text) => handle.edit(text),
        delete: (handle) => handle.delete(),
        latestId: (binding) => latestMessageId(threadFor(binding)),
        idOf: (handle) => handle.id,
        mapError: (operation, cause) => publicationError(operation, cause),
        // Discord has no per-turn status, so working messages render as
        // subtext. Final responses bypass this and post unchanged.
        formatWorking: kind === 'discord' ? formatDiscordWorkingStatus : undefined,
      })

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
              // A routed first message lives in the parent channel while its
              // binding already points at the new native thread, so fall back
              // to the other location before failing. The primary location
              // succeeds for ordinary messages without an extra scan.
              if (isThreadStarter) {
                if (await react(String(target.binding.channelId))) return
                if (await react(String(target.binding.conversationId))) return
              } else {
                if (await react(String(target.binding.conversationId))) return
                if (await react(String(target.binding.channelId))) return
              }
              throw new Error(`Message '${target.messageId}' was not found for acknowledgement.`)
            },
            catch: (cause) => publicationError('acknowledge', cause),
          }),
        beginWorking: (message) => workingLifecycle.begin(message),
        updateWorking: (message) => workingLifecycle.update(message),
        finalizeWorking: (message) => workingLifecycle.finalize(message),
        discardWorking: (binding) => workingLifecycle.discard(binding),
        setConversationTitle: options.setConversationTitle ?? (() => Effect.void),
        setAgentActivity: options.setAgentActivity ?? (() => Effect.void),
        searchMessages:
          options.searchMessages ??
          (() => Effect.succeed({ messages: [], scannedCount: 0, truncated: false })),
        withTyping: (_binding, effect) => effect,
      }
    }),
)
