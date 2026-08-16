import { createDiscordAdapter } from '@chat-adapter/discord'
import { Chat } from 'chat'
import * as Effect from 'effect/Effect'

import { SurfaceIngestion } from '../SurfaceIngestion.ts'
import { Surfaces } from '../Surfaces.ts'
import { makeChatSdkLifecycle } from '../chat-sdk/ChatSdkLifecycle.ts'
import { makeChatSdkSurface } from '../chat-sdk/ChatSdkSurface.ts'
import { makeSqliteChatStateAdapter } from '../chat-sdk/SqliteChatStateAdapter.ts'
import { startDiscordGateway } from './DiscordGateway.ts'
import {
  makeDiscordThreadBootstrap,
  type DiscordThreadBootstrapOptions,
} from './DiscordChannelBootstrap.ts'

export const startDiscord = Effect.fn('startDiscord')(function* () {
  const surfaces = yield* Surfaces
  const ingestion = yield* SurfaceIngestion
  const channelId = process.env.FRIDAY_DISCORD_CHANNEL_ID
  if (!channelId) return null

  const state = yield* makeSqliteChatStateAdapter()
  const discord = createDiscordAdapter({
    respondToChannelIds: [channelId],
  })
  const chat = new Chat({
    userName: 'Friday',
    // SAFETY: Chat SDK 4.38's generic Adapter declaration is not exact-optional
    // compatible with its concrete DiscordAdapter declaration under this repo's TS settings.
    adapters: { discord: discord as never },
    state,
    concurrency: 'concurrent',
  })
  const configuredModel = process.env.FRIDAY_PI_MODEL?.split('/')
  const bootstrapOptions: DiscordThreadBootstrapOptions = {
    discord,
    recentMessageCount: 20,
  }
  if (configuredModel?.[0]) bootstrapOptions.modelProvider = configuredModel[0]
  if (configuredModel && configuredModel.length > 1) {
    bootstrapOptions.modelId = configuredModel.slice(1).join('/')
  }
  const bootstrap = yield* makeDiscordThreadBootstrap(bootstrapOptions)
  const surface = yield* makeChatSdkSurface('discord', chat)
  yield* surfaces.register(surface)
  const lifecycle = yield* makeChatSdkLifecycle({
    chat,
    onInboundMessage: (input) => ingestion.ingest(input, bootstrap),
  })
  yield* startDiscordGateway(discord)
  return { lifecycle, surface }
})
