import type { DiscordAdapter } from '@chat-adapter/discord'
import { PlatformConversationId } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { PlatformInput } from '../PlatformAdapter.ts'
import { ChatSdkCallbackError } from '../chat-sdk/Errors.ts'
import { discordChannelConversationId, isDiscordThread } from './DiscordConversationScope.ts'
import {
  projectChatSdkMessage,
  type ChatSdkMessageProjectionSource,
  type ChatSdkThreadProjectionSource,
} from '../chat-sdk/MessageProjection.ts'

const ExistingDiscordThread = Schema.Struct({
  id: Schema.String,
  parent_id: Schema.String,
  type: Schema.Literals([10, 11, 12]),
})
const decodeExistingDiscordThread = Schema.decodeUnknownOption(ExistingDiscordThread)
const decodeConversationId = Schema.decodeSync(PlatformConversationId)

export interface DiscordMessageProjectionAdapter extends Pick<
  DiscordAdapter,
  'decodeThreadId' | 'encodeThreadId' | 'fetchChannelInfo'
> {}

const projectWithConversationId = (
  connectionId: string,
  thread: ChatSdkThreadProjectionSource,
  message: ChatSdkMessageProjectionSource,
  conversationId: string,
  discordHistorySource: 'channel' | 'thread',
): PlatformInput => {
  const input = projectChatSdkMessage(connectionId, thread, message)
  return {
    ...input,
    binding: {
      ...input.binding,
      conversationId: decodeConversationId(conversationId),
    },
    discordHistorySource,
  }
}

/** Repairs Chat SDK's parent-channel fallback when a message already owns a Discord thread. */
export const projectDiscordMessage = Effect.fn('projectDiscordMessage')(function* (
  connectionId: string,
  discord: DiscordMessageProjectionAdapter,
  thread: ChatSdkThreadProjectionSource,
  message: ChatSdkMessageProjectionSource,
) {
  const location = yield* Effect.try({
    try: () => discord.decodeThreadId(thread.id),
    catch: (cause) => new ChatSdkCallbackError({ operation: 'inbound-message', cause }),
  })
  if (isDiscordThread(location)) {
    return {
      ...projectChatSdkMessage(connectionId, thread, message),
      discordHistorySource: 'thread' as const,
    }
  }

  const channelConversationId = discordChannelConversationId(discord, location)
  if (location.guildId === '@me' || location.threadId === location.channelId) {
    return projectWithConversationId(
      connectionId,
      thread,
      message,
      channelConversationId,
      'channel',
    )
  }

  const existingThread = yield* Effect.promise(() =>
    discord.fetchChannelInfo(`discord:${location.guildId}:${message.id}`).then(
      (channel) => decodeExistingDiscordThread(channel.metadata.raw),
      () => null,
    ),
  )
  if (
    existingThread === null ||
    existingThread._tag === 'None' ||
    existingThread.value.parent_id !== location.channelId
  ) {
    return projectWithConversationId(
      connectionId,
      thread,
      message,
      channelConversationId,
      'channel',
    )
  }

  const repairedConversationId = discord.encodeThreadId({
    guildId: location.guildId,
    channelId: location.channelId,
    threadId: existingThread.value.id,
  })
  yield* Effect.logInfo('discord.thread-binding.repaired').pipe(
    Effect.annotateLogs({
      channelId: location.channelId,
      threadId: existingThread.value.id,
      messageId: message.id,
    }),
  )
  return projectWithConversationId(connectionId, thread, message, repairedConversationId, 'channel')
})
