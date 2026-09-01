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

export interface DiscordInitialContextAdapter extends Pick<
  DiscordAdapter,
  'decodeThreadId' | 'encodeThreadId'
> {
  readonly fetchMessages: (
    threadId: string,
    options: { readonly limit: number },
  ) => Promise<{ readonly messages: ReadonlyArray<DiscordHistoryMessage> }>
}

const boundedContext = (messages: ReadonlyArray<DiscordHistoryMessage>, triggerId: string) => {
  const context = []
  let characters = 0
  for (const message of messages.toReversed()) {
    if (message.id === triggerId || message.author.isBot || message.author.isMe) continue
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
) {
  const location = yield* Effect.try({
    try: () => discord.decodeThreadId(String(input.binding.conversationId)),
    catch: (cause) => new ChatSdkCallbackError({ operation: 'inbound-message', cause }),
  })
  const historySource = isDiscordThread(location)
    ? String(input.binding.conversationId)
    : discordChannelConversationId(discord, location)
  const result = yield* Effect.tryPromise({
    try: () => discord.fetchMessages(historySource, { limit: recentMessageCount }),
    catch: (cause) => new ChatSdkCallbackError({ operation: 'inbound-message', cause }),
  })
  return {
    ...input,
    initialContext: boundedContext(result.messages, String(input.message.platformMessageId ?? '')),
  }
})
