import type { DiscordAdapter } from '@chat-adapter/discord'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { ChatSdkCallbackError } from '../chat-sdk/Errors.ts'
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

export interface DiscordMessageProjectionAdapter extends Pick<
  DiscordAdapter,
  'decodeThreadId' | 'encodeThreadId' | 'fetchChannelInfo'
> {}

/** Repairs Chat SDK's parent-channel fallback when a message already owns a Discord thread. */
export const projectDiscordMessage = Effect.fn('projectDiscordMessage')(function* (
  discord: DiscordMessageProjectionAdapter,
  thread: ChatSdkThreadProjectionSource,
  message: ChatSdkMessageProjectionSource,
) {
  const location = yield* Effect.try({
    try: () => discord.decodeThreadId(thread.id),
    catch: (cause) => new ChatSdkCallbackError({ operation: 'inbound-message', cause }),
  })
  if (location.threadId !== undefined || location.guildId === '@me') {
    return projectChatSdkMessage(thread, message)
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
    return projectChatSdkMessage(thread, message)
  }

  const repairedThread = {
    ...thread,
    id: discord.encodeThreadId({
      guildId: location.guildId,
      channelId: location.channelId,
      threadId: existingThread.value.id,
    }),
  }
  yield* Effect.logInfo('discord.thread-binding.repaired').pipe(
    Effect.annotateLogs({
      channelId: location.channelId,
      threadId: existingThread.value.id,
      messageId: message.id,
    }),
  )
  return projectChatSdkMessage(repairedThread, message)
})
