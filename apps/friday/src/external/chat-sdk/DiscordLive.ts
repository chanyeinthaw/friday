import { createDiscordAdapter } from '@chat-adapter/discord'
import { Chat } from 'chat'
import * as Effect from 'effect/Effect'

import type { FridayApplicationContract } from '../../FridayApplication.ts'
import { ThreadPersistence } from '../../conversation/ThreadPersistence.ts'
import { makeExternalIngestion } from '../ExternalIngestion.ts'
import { makeChatSdkExternalPlatform } from './ChatSdkExternalPlatform.ts'
import { makeChatSdkLifecycle } from './ChatSdkLifecycle.ts'
import { startDiscordGateway } from './DiscordGateway.ts'
import {
  ensureDiscordChannelThread,
  type DiscordChannelBootstrapOptions,
} from './DiscordChannelBootstrap.ts'
import { makeSqliteChatStateAdapter } from './SqliteChatStateAdapter.ts'

export const makeDiscordLive = Effect.fn('makeDiscordLive')(function* <PromptError, EventError>(
  application: FridayApplicationContract<PromptError, EventError>,
) {
  const persistence = yield* ThreadPersistence
  const guildId = process.env.FRIDAY_DISCORD_GUILD_ID
  const channelId = process.env.FRIDAY_DISCORD_CHANNEL_ID
  if (!guildId || !channelId) return null

  const configuredModel = process.env.FRIDAY_PI_MODEL?.split('/')
  const bootstrapOptions: DiscordChannelBootstrapOptions = { guildId, channelId }
  if (configuredModel?.[0]) bootstrapOptions.modelProvider = configuredModel[0]
  if (configuredModel && configuredModel.length > 1) {
    bootstrapOptions.modelId = configuredModel.slice(1).join('/')
  }
  yield* ensureDiscordChannelThread(bootstrapOptions)
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
  const platform = yield* makeChatSdkExternalPlatform(chat)
  const ingestion = yield* makeExternalIngestion(application, platform).pipe(
    Effect.provideService(ThreadPersistence, persistence),
  )
  const lifecycle = yield* makeChatSdkLifecycle({
    chat,
    onInboundMessage: ingestion.ingest,
  })
  yield* startDiscordGateway(discord)
  return { lifecycle, platform }
})
