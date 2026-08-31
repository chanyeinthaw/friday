import { Chat } from 'chat'
import * as Effect from 'effect/Effect'

import { InvocationPolicies, shouldInvoke } from '../InvocationPolicies.ts'
import { PlatformIngestion } from '../PlatformIngestion.ts'
import { isAllowedByAccess, isAllowedByPolicy } from '../chat-sdk/AccessPolicy.ts'
import { AppConfig } from '../../config/AppConfigLive.ts'
import { ChatSdkCallbackError, ChatSdkLifecycleError } from '../chat-sdk/Errors.ts'
import { PlatformRegistry } from '../PlatformRegistry.ts'
import { startChatSdkLifecycle } from '../chat-sdk/ChatSdkLifecycle.ts'
import { makeChatSdkPlatform } from '../chat-sdk/ChatSdkPlatform.ts'
import { makeSqliteChatStateAdapter } from '../chat-sdk/SqliteChatStateAdapter.ts'
import { makeDiscordAgentActivity } from './DiscordAgentActivity.ts'
import {
  makeDiscordInvocationChannelSelector,
  makeDiscordLocationGate,
} from './DiscordChannelAccess.ts'
import { setDiscordConversationTitle } from './DiscordConversationTitle.ts'
import { startDiscordGateway } from './DiscordGateway.ts'
import { loadDiscordInitialContext } from './DiscordInitialContext.ts'
import { projectDiscordMessage } from './DiscordMessageProjection.ts'
import {
  FridayDiscordAdapter,
  type FridayDiscordAdapterConfig,
} from './DiscordSystemChannelAdapter.ts'
import {
  isDiscordSystemChannel,
  projectDiscordSystemChannelMessage,
} from './DiscordSystemChannel.ts'
import { searchDiscordMessages } from './DiscordMessageSearch.ts'
import {
  makeDiscordThreadBootstrap,
  type DiscordThreadBootstrapOptions,
} from './DiscordChannelBootstrap.ts'

export const startDiscord = Effect.fn('startDiscord')(function* () {
  const platforms = yield* PlatformRegistry
  const invocationPolicies = yield* InvocationPolicies
  const ingestion = yield* PlatformIngestion
  const configuration = yield* AppConfig
  const connections = configuration.platforms.discord
  if (connections.length === 0) {
    yield* Effect.logDebug('discord.disabled').pipe(Effect.annotateLogs({ component: 'discord' }))
    return []
  }

  return yield* Effect.forEach(
    connections,
    (discordConfig) =>
      Effect.gen(function* () {
        const state = yield* makeSqliteChatStateAdapter(`friday:${discordConfig.connectionId}`)
        const invocationChannels = makeDiscordInvocationChannelSelector(
          discordConfig.access.channels,
          discordConfig.invocation,
        )
        const isAllowedLocation = makeDiscordLocationGate(
          discordConfig.access.guilds,
          discordConfig.access.channels,
        )
        const discord = yield* Effect.try({
          try: () =>
            new FridayDiscordAdapter({
              botToken: String(discordConfig.credentials.botToken),
              applicationId: String(discordConfig.credentials.applicationId),
              publicKey: String(discordConfig.credentials.publicKey),
              mentionRoleIds: [...discordConfig.mentionRoleIds],
              // Friday owns invocation policy and refreshes this selector from SQLite.
              respondToChannelIds: invocationChannels.channels,
              respondToGlobalMentions: true,
              systemChannelIds: discordConfig.systemChannelIds,
              // The adapter must ignore unconfigured guilds/channels before it
              // creates any Discord thread on Friday's behalf.
              isAllowedLocation,
            } satisfies FridayDiscordAdapterConfig),
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
          systemChannelIds: discordConfig.systemChannelIds,
          model: configuration.models.primary,
          thinkingLevel: configuration.models.primary.thinkingLevel,
        }
        const bootstrap = yield* makeDiscordThreadBootstrap(bootstrapOptions)
        const botToken = String(discordConfig.credentials.botToken)
        const platform = yield* makeChatSdkPlatform(discordConfig.connectionId, 'discord', chat, {
          setConversationTitle: (title) => setDiscordConversationTitle(discord, botToken, title),
          setAgentActivity: makeDiscordAgentActivity(discord, botToken),
          searchMessages: (query) => searchDiscordMessages(discord, query),
        })
        yield* platforms.register(platform)
        yield* invocationPolicies.watch(discordConfig.connectionId, (configuration) =>
          Effect.sync(() => invocationChannels.update(configuration)),
        )
        yield* startChatSdkLifecycle({
          connectionId: discordConfig.connectionId,
          chat,
          normalizeInboundMessage: (thread, message) =>
            isDiscordSystemChannel(discord, thread, discordConfig.systemChannelIds)
              ? Effect.succeed(
                  projectDiscordSystemChannelMessage(
                    discordConfig.connectionId,
                    discord,
                    thread,
                    message,
                  ),
                )
              : projectDiscordMessage(discordConfig.connectionId, discord, thread, message),
          shouldHandleMessage: (kind, thread, message) =>
            Effect.try({
              try: () => {
                const location = discord.decodeThreadId(thread.id)
                const systemChannel =
                  discordConfig.systemChannelIds.includes(location.channelId) &&
                  (location.threadId === undefined || location.threadId === location.channelId)
                const guildAllowed = isAllowedByPolicy(
                  location.guildId,
                  discordConfig.access.guilds,
                )
                return {
                  accessAllowed:
                    guildAllowed &&
                    isAllowedByAccess({
                      userId: message.author.userId,
                      channelId: location.channelId,
                      userPolicy: discordConfig.access.users,
                      channelPolicy: discordConfig.access.channels,
                    }),
                  location,
                  systemChannel,
                }
              },
              catch: (cause) => new ChatSdkCallbackError({ operation: 'inbound-message', cause }),
            }).pipe(
              Effect.flatMap(({ accessAllowed, location, systemChannel }) =>
                accessAllowed
                  ? Effect.all({
                      mode: invocationPolicies.effectiveMode(
                        discordConfig.connectionId,
                        location.channelId,
                      ),
                      input: (systemChannel
                        ? Effect.succeed(
                            projectDiscordSystemChannelMessage(
                              discordConfig.connectionId,
                              discord,
                              thread,
                              message,
                            ),
                          )
                        : projectDiscordMessage(
                            discordConfig.connectionId,
                            discord,
                            thread,
                            message,
                          )
                      ).pipe(
                        Effect.flatMap((input) => ingestion.hasBinding(input)),
                        Effect.mapError(
                          (cause) =>
                            new ChatSdkCallbackError({ operation: 'inbound-message', cause }),
                        ),
                      ),
                    }).pipe(
                      Effect.mapError(
                        (cause) =>
                          new ChatSdkCallbackError({ operation: 'inbound-message', cause }),
                      ),
                      Effect.map(({ mode, input: hasBinding }) => ({
                        allowed: shouldInvoke({ kind, mode, hasBinding }),
                        location,
                        mode,
                      })),
                    )
                  : Effect.succeed({
                      allowed: false,
                      location,
                      mode: null,
                    }).pipe(
                      Effect.map(
                        (
                          result,
                        ): {
                          readonly allowed: boolean
                          readonly location: typeof location
                          readonly mode: 'all-messages' | 'mention-only' | null
                        } => result,
                      ),
                    ),
              ),
              Effect.tap(({ allowed, location, mode }) =>
                allowed
                  ? Effect.logDebug('discord.message.allowed').pipe(
                      Effect.annotateLogs({
                        component: 'discord',
                        connectionId: discordConfig.connectionId,
                        channelId: location.channelId,
                        invocationKind: kind,
                        invocationMode: mode,
                      }),
                    )
                  : Effect.logDebug('discord.message.ignored').pipe(
                      Effect.annotateLogs({
                        component: 'discord',
                        guildId: location.guildId,
                        channelId: location.channelId,
                        userId: message.author.userId,
                        invocationKind: kind,
                        invocationMode: mode,
                      }),
                    ),
              ),
              Effect.map(({ allowed }) => allowed),
            ),
          onInboundMessage: (input) =>
            ingestion.ingest(input, bootstrap, (initialInput) =>
              loadDiscordInitialContext(
                discord,
                configuration.agent.recentMessageCount,
                initialInput,
              ),
            ),
        })
        yield* startDiscordGateway(discord)
        yield* Effect.logInfo('discord.started').pipe(
          Effect.annotateLogs({
            component: 'discord',
            connectionId: discordConfig.connectionId,
            guildAccessMode: discordConfig.access.guilds.mode,
            guildAccessCount: discordConfig.access.guilds.ids.length,
            channelAccessMode: discordConfig.access.channels.mode,
            channelAccessCount: discordConfig.access.channels.ids.length,
            userAccessMode: discordConfig.access.users.mode,
            userAccessCount: discordConfig.access.users.ids.length,
            systemChannelCount: discordConfig.systemChannelIds.length,
          }),
        )
        return { connectionId: discordConfig.connectionId, platform }
      }),
    { concurrency: 'unbounded' },
  )
})
