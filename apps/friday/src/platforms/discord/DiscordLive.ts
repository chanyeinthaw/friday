import { DiscordInteractionResponseFlag } from '@chat-adapter/discord'
import { Chat, type SlashCommandEvent } from 'chat'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'

import { DiscordActivityDescriptions } from '../DiscordActivityDescriptions.ts'
import { effectiveInvocationMode, shouldInvoke } from '../InvocationPolicies.ts'
import { PlatformIngestion } from '../PlatformIngestion.ts'
import { isAllowedByAccess, isAllowedByPolicy } from '../chat-sdk/AccessPolicy.ts'
import { AppConfig } from '../../config/AppConfigLive.ts'
import { findDiscordConnection } from '../../config/AppConfig.ts'
import { reloadApplicationConfig } from '../../config/ConfigReload.ts'
import { ChatSdkCallbackError, ChatSdkLifecycleError } from '../chat-sdk/Errors.ts'
import { PlatformRegistry } from '../PlatformRegistry.ts'
import { startChatSdkLifecycle } from '../chat-sdk/ChatSdkLifecycle.ts'
import { makeChatSdkPlatform } from '../chat-sdk/ChatSdkPlatform.ts'
import { makeSqliteChatStateAdapter } from '../chat-sdk/SqliteChatStateAdapter.ts'
import {
  findDuplicateDiscordApplications,
  makeDiscordAgentActivity,
} from './DiscordAgentActivity.ts'
import {
  makeDiscordInvocationChannelSelector,
  makeDiscordLocationGate,
  type DiscordConnectionPolicies,
  type DiscordPolicyProvider,
} from './DiscordChannelAccess.ts'
import { registerGlobalFridayCommand } from './DiscordCommandRegistration.ts'
import { setDiscordConversationTitle } from './DiscordConversationTitle.ts'
import { startDiscordGateway } from './DiscordGateway.ts'
import { loadDiscordInitialContext } from './DiscordInitialContext.ts'
import { projectDiscordMessage } from './DiscordMessageProjection.ts'
import {
  FRIDAY_COMMAND_PATHS,
  decideFridayCommand,
  decodeFridayInteraction,
  fridayCommandReply,
  fridayReloadReply,
  fridaySubcommand,
} from './DiscordSlashCommand.ts'
import {
  FridayDiscordAdapter,
  type FridayDiscordAdapterConfig,
} from './DiscordSystemChannelAdapter.ts'
import {
  isDiscordSystemChannel,
  projectDiscordSystemChannelMessage,
} from './DiscordSystemChannel.ts'
import { searchDiscordMessages } from './DiscordMessageSearch.ts'
import { withDiscordThreadActivityTitle } from './DiscordThreadActivityTitle.ts'
import {
  makeDiscordThreadBootstrap,
  type DiscordThreadBootstrapOptions,
} from './DiscordChannelBootstrap.ts'

export const startDiscord = Effect.fn('startDiscord')(function* () {
  const platforms = yield* PlatformRegistry
  const activityDescriptions = yield* DiscordActivityDescriptions
  const ingestion = yield* PlatformIngestion
  const config = yield* AppConfig
  // Startup topology snapshot: Discord resources are built once per process.
  const startup = config.current()
  const connections = startup.platforms.discord
  if (connections.length === 0) {
    yield* Effect.logDebug('discord.disabled').pipe(Effect.annotateLogs({ component: 'discord' }))
    return []
  }
  // Admin allow-list is pinned to the running snapshot so database edits cannot
  // lock administrators out of running reloads; changes require a restart.
  const admin = startup.admin
  const duplicateApplications = findDuplicateDiscordApplications(
    connections.map((connection) => ({
      connectionId: String(connection.connectionId),
      applicationId: String(connection.credentials.applicationId),
      botToken: String(connection.credentials.botToken),
    })),
  )
  if (duplicateApplications.length > 0) {
    return yield* new ChatSdkLifecycleError({
      operation: 'create-adapter',
      cause: new Error(
        `Duplicate Discord application connections: ${duplicateApplications
          .map((connectionIds) => connectionIds.join(', '))
          .join('; ')}`,
      ),
    })
  }

  return yield* Effect.forEach(
    connections,
    (discordConfig) =>
      Effect.gen(function* () {
        const state = yield* makeSqliteChatStateAdapter(`friday:${discordConfig.connectionId}`)
        // Reloadable policies are read from the in-memory snapshot on every
        // message; the Discord resources above never observe partial swaps.
        const policies: DiscordPolicyProvider = () =>
          Option.map(
            findDiscordConnection(config.current(), discordConfig.connectionId),
            (connection): DiscordConnectionPolicies => ({
              guilds: connection.access.guilds,
              channels: connection.access.channels,
              users: connection.access.users,
              invocation: connection.invocation,
              systemChannelIds: connection.systemChannelIds,
            }),
          )
        const currentPolicies = (): DiscordConnectionPolicies =>
          Option.getOrElse(policies(), (): DiscordConnectionPolicies => ({
            guilds: { mode: 'deny', ids: [] },
            channels: { mode: 'deny', ids: [] },
            users: { mode: 'deny', ids: [] },
            invocation: { defaultMode: 'mention-only', channels: [] },
            systemChannelIds: [],
          }))
        const invocationChannels = makeDiscordInvocationChannelSelector(policies)
        const isAllowedLocation = makeDiscordLocationGate(policies)
        const discord = yield* Effect.try({
          try: () =>
            new FridayDiscordAdapter({
              botToken: String(discordConfig.credentials.botToken),
              applicationId: String(discordConfig.credentials.applicationId),
              publicKey: String(discordConfig.credentials.publicKey),
              mentionRoleIds: [...discordConfig.mentionRoleIds],
              // Friday owns invocation and access policy through the snapshot.
              respondToChannelIds: invocationChannels.channels,
              respondToGlobalMentions: true,
              systemChannelIds: () => currentPolicies().systemChannelIds,
              // The adapter must ignore unconfigured guilds/channels before it
              // creates any Discord thread on Friday's behalf.
              isAllowedLocation,
              // The adapter flattens (or drops) subcommands in the command
              // path depending on arguments; match every produced path and
              // make the reload reply ephemeral.
              interactionFlags: (context) =>
                FRIDAY_COMMAND_PATHS.includes(context.command)
                  ? DiscordInteractionResponseFlag.Ephemeral
                  : undefined,
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
          // The bootstrap reads system channels live so reloaded system channels
          // bind new threads to the parent channel instead of a child thread.
          systemChannelIds: () => currentPolicies().systemChannelIds,
          model: () => config.current().models.primary,
        }
        const bootstrap = yield* makeDiscordThreadBootstrap(bootstrapOptions)
        const botToken = String(discordConfig.credentials.botToken)
        const setAgentActivity = yield* makeDiscordAgentActivity(discord, botToken, {
          activityDescription: discordConfig.activityDescription,
          watchActivityDescription: (onChange) =>
            activityDescriptions.watch(discordConfig.connectionId, onChange),
          installationId: startup.installationId,
        })
        const chatSdkPlatform = yield* makeChatSdkPlatform(
          discordConfig.connectionId,
          'discord',
          chat,
          {
            setConversationTitle: (title) => setDiscordConversationTitle(discord, title),
            setAgentActivity,
            searchMessages: (query) => searchDiscordMessages(discord, query),
          },
        )
        const platform = withDiscordThreadActivityTitle(discord, chatSdkPlatform)
        yield* platforms.register(platform)
        const runFridayCommand = (event: SlashCommandEvent) =>
          Effect.gen(function* () {
            const decision = decideFridayCommand({
              subcommand: Option.flatMap(decodeFridayInteraction(event.raw), fridaySubcommand),
              userId: event.user.userId,
              admin,
            })
            if (decision.kind !== 'reload') {
              yield* respondEphemeral(event, fridayCommandReply(decision))
              return
            }
            const outcome = yield* reloadApplicationConfig(config)
            yield* respondEphemeral(event, fridayReloadReply(outcome))
            yield* Effect.logInfo('discord.command.reload').pipe(
              Effect.annotateLogs({
                component: 'discord',
                connectionId: discordConfig.connectionId,
                userId: event.user.userId,
              }),
            )
          }).pipe(
            Effect.catchCause((cause) => Effect.logError('Friday slash command failed', cause)),
          )
        chat.onSlashCommand(FRIDAY_COMMAND_PATHS, (event) =>
          Effect.runPromise(runFridayCommand(event)).then(() => undefined),
        )
        yield* startChatSdkLifecycle({
          connectionId: discordConfig.connectionId,
          chat,
          normalizeInboundMessage: (thread, message) =>
            isDiscordSystemChannel(discord, thread, currentPolicies().systemChannelIds)
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
                const policiesNow = currentPolicies()
                const systemChannel =
                  policiesNow.systemChannelIds.includes(location.channelId) &&
                  (location.threadId === undefined || location.threadId === location.channelId)
                return {
                  accessAllowed:
                    isAllowedByPolicy(location.guildId, policiesNow.guilds) &&
                    isAllowedByAccess({
                      userId: message.author.userId,
                      channelId: location.channelId,
                      userPolicy: policiesNow.users,
                      channelPolicy: policiesNow.channels,
                    }),
                  location,
                  systemChannel,
                  mode: effectiveInvocationMode(policiesNow.invocation, location.channelId),
                }
              },
              catch: (cause) => new ChatSdkCallbackError({ operation: 'inbound-message', cause }),
            }).pipe(
              Effect.flatMap(({ accessAllowed, location, systemChannel, mode }) =>
                accessAllowed
                  ? Effect.all({
                      mode: Effect.succeed(mode),
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
                config.current().agent.recentMessageCount,
                initialInput,
              ),
            ),
        })
        // Register the application command before the gateway starts so a
        // registration failure cannot leave partially started Discord resources.
        yield* registerGlobalFridayCommand({
          botToken,
          applicationId: String(discordConfig.credentials.applicationId),
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

const respondEphemeral = (event: SlashCommandEvent, message: string) =>
  Effect.tryPromise({
    // The Discord adapter (chat SDK 4.38) implements no postEphemeral, so a
    // direct postEphemeral call returns null and leaves the deferred interaction
    // response hanging. Posting through the channel is intercepted by the
    // adapter's slash-command context and completes the interaction webhook's
    // original response; the Ephemeral interactionFlags set at deferReply keep
    // it visible only to the caller.
    try: () => event.channel.post(message),
    catch: (cause) => new ChatSdkCallbackError({ operation: 'slash-command', cause }),
  }).pipe(Effect.asVoid)
