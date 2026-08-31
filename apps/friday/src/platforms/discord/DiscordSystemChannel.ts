import type { DiscordAdapter } from '@chat-adapter/discord'
import type { PlatformInput } from '../PlatformAdapter.ts'
import type {
  ChatSdkMessageProjectionSource,
  ChatSdkThreadProjectionSource,
} from '../chat-sdk/MessageProjection.ts'
import { projectChatSdkMessage } from '../chat-sdk/MessageProjection.ts'

export const isDiscordSystemChannel = (
  discord: Pick<DiscordAdapter, 'decodeThreadId'>,
  thread: ChatSdkThreadProjectionSource,
  systemChannelIds: ReadonlyArray<string>,
): boolean => {
  const location = discord.decodeThreadId(thread.id)
  return (
    systemChannelIds.includes(location.channelId) &&
    (location.threadId === undefined || location.threadId === location.channelId)
  )
}

/** Bind system-channel messages to the parent channel itself, never a Discord child thread. */
export const projectDiscordSystemChannelMessage = (
  connectionId: string,
  discord: Pick<DiscordAdapter, 'decodeThreadId' | 'encodeThreadId'>,
  thread: ChatSdkThreadProjectionSource,
  message: ChatSdkMessageProjectionSource,
): PlatformInput => {
  const location = discord.decodeThreadId(thread.id)
  const channelThread: ChatSdkThreadProjectionSource = {
    id: discord.encodeThreadId({ guildId: location.guildId, channelId: location.channelId }),
    channelId: thread.channelId,
    adapter: thread.adapter,
  }
  return projectChatSdkMessage(connectionId, channelThread, message)
}
