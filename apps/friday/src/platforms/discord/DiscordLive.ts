import { createDiscordAdapter } from '@chat-adapter/discord'
import { Chat } from 'chat'
import * as Effect from 'effect/Effect'

import { PlatformIngestion } from '../PlatformIngestion.ts'
import { isAllowedByIds } from '../chat-sdk/Allowlist.ts'
import { AppConfig } from '../../config/AppConfigLive.ts'
import { ChatSdkCallbackError, ChatSdkLifecycleError } from '../chat-sdk/Errors.ts'
import { PlatformRegistry } from '../PlatformRegistry.ts'
import { startChatSdkLifecycle } from '../chat-sdk/ChatSdkLifecycle.ts'
import { makeChatSdkPlatform } from '../chat-sdk/ChatSdkPlatform.ts'
import { makeSqliteChatStateAdapter } from '../chat-sdk/SqliteChatStateAdapter.ts'
import { startDiscordGateway } from './DiscordGateway.ts'
import {
  makeDiscordThreadBootstrap,
  type DiscordThreadBootstrapOptions,
} from './DiscordChannelBootstrap.ts'

export const startDiscord = Effect.fn('startDiscord')(function* () {
  const platforms = yield* PlatformRegistry
  const ingestion = yield* PlatformIngestion
  const configuration = yield* AppConfig
  const discordConfig = configuration.platforms.discord
  if (!discordConfig) return null

  const state = yield* makeSqliteChatStateAdapter()
  const discord = yield* Effect.try({
    try: () =>
      createDiscordAdapter({
        botToken: String(discordConfig.credentials.botToken),
        applicationId: String(discordConfig.credentials.applicationId),
        publicKey: String(discordConfig.credentials.publicKey),
        mentionRoleIds: [...discordConfig.mentionRoleIds],
        respondToChannelIds: [...discordConfig.allowlist.channelIds],
        respondToGlobalMentions: discordConfig.respondToGlobalMentions,
      }),
    catch: (cause) => new ChatSdkLifecycleError({ operation: 'create-adapter', cause }),
  })
  const chat = yield* Effect.try({
    try: () =>
      new Chat({
        userName: 'Friday',
        // SAFETY: Chat SDK 4.38's generic Adapter declaration is not exact-optional
        // compatible with its concrete DiscordAdapter declaration under this repo's TS settings.
        adapters: { discord: discord as never },
        state,
        concurrency: 'concurrent',
      }),
    catch: (cause) => new ChatSdkLifecycleError({ operation: 'create-chat', cause }),
  })
  const bootstrapOptions: DiscordThreadBootstrapOptions = {
    discord,
    recentMessageCount: configuration.agent.recentMessageCount,
    model: configuration.models.primary,
    thinkingLevel: configuration.agent.thinkingLevel,
  }
  const bootstrap = yield* makeDiscordThreadBootstrap(bootstrapOptions)
  const platform = yield* makeChatSdkPlatform('discord', chat)
  yield* platforms.register(platform)
  yield* startChatSdkLifecycle({
    chat,
    shouldHandleMessage: (thread, message) =>
      Effect.try({
        try: () => {
          const location = discord.decodeThreadId(thread.id)
          const guildAllowed =
            discordConfig.allowlist.guildIds.length === 0 ||
            discordConfig.allowlist.guildIds.includes(location.guildId)
          return (
            guildAllowed &&
            isAllowedByIds({
              userId: message.author.userId,
              channelId: location.channelId,
              allowlist: discordConfig.allowlist,
            })
          )
        },
        catch: (cause) => new ChatSdkCallbackError({ operation: 'inbound-message', cause }),
      }),
    onInboundMessage: (input) => ingestion.ingest(input, bootstrap),
  })
  yield* startDiscordGateway(discord)
  return { platform }
})
