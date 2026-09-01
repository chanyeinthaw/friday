import type { DiscordAdapter } from '@chat-adapter/discord'
import * as Effect from 'effect/Effect'

import type { PlatformInput } from '../PlatformAdapter.ts'
import { ChatSdkCallbackError } from '../chat-sdk/Errors.ts'
import { projectChatSdkContextMessage } from '../chat-sdk/MessageProjection.ts'
import { discordChannelConversationId, isDiscordThread } from './DiscordConversationScope.ts'

const MaximumRenderedCharacters = 8_000

interface DiscordHistoryMessage {
  readonly id: string
  readonly text: string
  readonly author: {
    readonly userId: string
    readonly userName: string
    readonly fullName: string
    readonly isBot: boolean | 'unknown'
    readonly isMe: boolean
  }
}

export const shouldLoadDiscordContext = (input: {
  readonly created: boolean
  readonly invocationMode: 'mention-only' | 'all-messages'
  readonly replyMode: 'reply-in-thread' | 'reply-in-channel'
}): boolean =>
  input.created || input.invocationMode === 'mention-only' || input.replyMode === 'reply-in-channel'

export interface DiscordInitialContextAdapter extends Pick<
  DiscordAdapter,
  'decodeThreadId' | 'encodeThreadId'
> {
  readonly fetchMessages: (
    threadId: string,
    options: { readonly limit: number },
  ) => Promise<{ readonly messages: ReadonlyArray<DiscordHistoryMessage> }>
}

const boundedContext = (
  messages: ReadonlyArray<DiscordHistoryMessage>,
  triggerId: string,
  afterMessageId?: string,
) => {
  const afterIndex =
    afterMessageId === undefined
      ? -1
      : messages.findIndex((message) => message.id === afterMessageId)
  const triggerIndex = messages.findIndex((message) => message.id === triggerId)
  const candidates = messages.slice(afterIndex + 1, triggerIndex < 0 ? undefined : triggerIndex)
  const context = []
  let characters = 0
  for (const message of candidates.toReversed()) {
    if (message.id === triggerId || message.author.isBot || message.author.isMe) {
      continue
    }
    const projected = projectChatSdkContextMessage('discord', message)
    if (characters + projected.content.text.length > MaximumRenderedCharacters) break
    characters += projected.content.text.length
    context.push(projected)
  }
  return context.reverse()
}

export const loadDiscordInitialContext = Effect.fn('loadDiscordInitialContext')(function* (
  discord: DiscordInitialContextAdapter,
  recentMessageCount: number,
  input: PlatformInput,
  cursor: {
    readonly created: boolean
    readonly afterMessageId?: string | undefined
  } = { created: true },
) {
  const location = yield* Effect.try({
    try: () => discord.decodeThreadId(String(input.binding.conversationId)),
    catch: (cause) => new ChatSdkCallbackError({ operation: 'inbound-message', cause }),
  })
  const isNewThreadFromTrigger =
    cursor.created && location.threadId === String(input.message.platformMessageId ?? '')
  const historySource =
    isDiscordThread(location) && !isNewThreadFromTrigger
      ? String(input.binding.conversationId)
      : discordChannelConversationId(discord, location)
  const result = yield* Effect.tryPromise({
    try: () => discord.fetchMessages(historySource, { limit: recentMessageCount }),
    catch: (cause) => new ChatSdkCallbackError({ operation: 'inbound-message', cause }),
  })
  return {
    ...input,
    initialContext: boundedContext(
      result.messages,
      String(input.message.platformMessageId ?? ''),
      cursor.afterMessageId,
    ),
  }
})
