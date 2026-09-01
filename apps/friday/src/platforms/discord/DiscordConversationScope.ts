import type { DiscordAdapter } from '@chat-adapter/discord'

export interface DiscordConversationLocation {
  readonly guildId?: string | undefined
  readonly channelId?: string | undefined
  readonly threadId?: string | undefined
}

export const isDiscordThread = (location: DiscordConversationLocation): boolean =>
  location.threadId !== undefined && location.threadId !== location.channelId

export const discordChannelConversationId = (
  discord: Pick<DiscordAdapter, 'encodeThreadId'>,
  location: { readonly guildId: string; readonly channelId: string },
): string =>
  discord.encodeThreadId({
    guildId: location.guildId,
    channelId: location.channelId,
    threadId: location.channelId,
  })
