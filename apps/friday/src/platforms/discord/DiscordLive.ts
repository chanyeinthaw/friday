import { DiscordInteractionResponseFlag } from '@chat-adapter/discord'
import { Chat, type SlashCommandEvent } from 'chat'
import { PlatformConversationId } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { DiscordActivityDescriptions } from '../DiscordActivityDescriptions.ts'
import { PlatformIngestion } from '../PlatformIngestion.ts'
import { isAllowedByPolicy } from '../chat-sdk/AccessPolicy.ts'
import { AppConfig } from '../../config/AppConfigLive.ts'
import { findDiscordConnection } from '../../config/AppConfig.ts'
import { reloadApplicationConfig } from '../../config/ConfigReload.ts'
import { reloadConversationHarness } from '../../conversation/HarnessReload.ts'
import { ThreadPersistence } from '../../conversation/ThreadPersistence.ts'
import { ThreadRuntimePool } from '../../conversation/ThreadRuntimePool.ts'
import { harnessReloadRefused } from '../../conversation/ThreadRuntime.ts'
import { ChatSdkCallbackError, ChatSdkLifecycleError } from '../chat-sdk/Errors.ts'
import type { InvocationMode } from '../../config/AppConfig.ts'
import { PlatformRegistry } from '../PlatformRegistry.ts'
import { startChatSdkLifecycle } from '../chat-sdk/ChatSdkLifecycle.ts'
import { makeChatSdkPlatform } from '../chat-sdk/ChatSdkPlatform.ts'
import { makeSqliteChatStateAdapter } from '../chat-sdk/SqliteChatStateAdapter.ts'
import {
  findDuplicateDiscordApplications,
  makeDiscordAgentActivity,
} from './DiscordAgentActivity.ts'
import {
  replyInChannelChannelIds,
  resolveDiscordChannelPolicy,
  shouldInvoke,
  type DiscordConnectionPolicies,
  type DiscordPolicyProvider,
} from './DiscordChannelAccess.ts'
import { registerGlobalDiscordCommands } from './DiscordCommandRegistration.ts'
import { setDiscordConversationTitle } from './DiscordConversationTitle.ts'
import { discordCanonicalConversationId } from './DiscordConversationScope.ts'
import { startDiscordGateway } from './DiscordGateway.ts'
import { loadDiscordInitialContext, shouldLoadDiscordContext } from './DiscordInitialContext.ts'
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
  HARNESS_COMMAND_PATHS,
  decideHarnessCommand,
  decodeHarnessInteraction,
  harnessCommandReply,
  harnessReloadReply,
  harnessSubcommand,
} from './DiscordHarnessCommand.ts'
import { FridayDiscordAdapter, type FridayDiscordAdapterConfig } from './FridayDiscordAdapter.ts'
import { searchDiscordMessages } from './DiscordMessageSearch.ts'
import {
  makeDiscordThreadBootstrap,
  type DiscordThreadBootstrapOptions,
} from './DiscordChannelBootstrap.ts'

const decodePlatformConversationId = Schema.decodeOption(PlatformConversationId)

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
              users: connection.users,
              guilds: connection.guilds,
            }),
          )
        const currentPolicies = (): DiscordConnectionPolicies =>
          Option.getOrElse(policies(), (): DiscordConnectionPolicies => ({
            users: { mode: 'deny', ids: [] },
            guilds: [],
          }))
        const resolveChannelPolicy = (guildId: string, channelId: string) =>
          Option.getOrUndefined(resolveDiscordChannelPolicy(currentPolicies(), guildId, channelId))
        const discord = yield* Effect.try({
          try: () =>
            new FridayDiscordAdapter({
              botToken: String(discordConfig.credentials.botToken),
              applicationId: String(discordConfig.credentials.applicationId),
              publicKey: String(discordConfig.credentials.publicKey),
              mentionRoleIds: [...discordConfig.mentionRoleIds],
              respondToGlobalMentions: discordConfig.respondToGlobalMentions,
              // Friday owns invocation, reply mode, and permission policy
              // through the snapshot; the adapter drops anything unresolved.
              resolveChannelPolicy,
              replyInChannelChannelIds: () => replyInChannelChannelIds(currentPolicies()),
              // The adapter flattens (or drops) subcommands in the command
              // path depending on arguments; match every produced path and
              // make the Friday and harness command replies ephemeral.
              interactionFlags: (context) =>
                [...FRIDAY_COMMAND_PATHS, ...HARNESS_COMMAND_PATHS].includes(context.command)
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
        yield* platforms.register(chatSdkPlatform)
        // Harness reload targets the thread bound to the invoking conversation
        // and its already-open runtime; both lookups are connection-scoped.
        const persistence = yield* ThreadPersistence
        const pool = yield* ThreadRuntimePool
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
        const runHarnessCommand = (event: SlashCommandEvent) =>
          Effect.gen(function* () {
            // No authorization guard: /harness reload is intentionally open to
            // any caller, unlike /friday reload.
            const decision = decideHarnessCommand({
              subcommand: Option.flatMap(decodeHarnessInteraction(event.raw), harnessSubcommand),
            })
            if (decision.kind !== 'reload') {
              yield* respondEphemeral(event, harnessCommandReply(decision))
              return
            }
            const canonicalConversationId = yield* Effect.try(() =>
              discordCanonicalConversationId(discord, event.channel.id),
            ).pipe(Effect.option)
            const conversationId = Option.flatMap(
              canonicalConversationId,
              decodePlatformConversationId,
            )
            if (Option.isNone(conversationId)) {
              yield* respondEphemeral(
                event,
                harnessReloadReply(
                  harnessReloadRefused(
                    'unknown-thread',
                    'No Friday thread is bound to this conversation; run the command inside a Friday thread.',
                  ),
                ),
              )
              return
            }
            const outcome = yield* reloadConversationHarness({
              findThread: persistence.findPlatformThread,
              reloadRuntime: pool.reloadHarness,
            })({
              platform: 'discord',
              connectionId: discordConfig.connectionId,
              conversationId: conversationId.value,
            })
            yield* respondEphemeral(event, harnessReloadReply(outcome))
            yield* Effect.logInfo('discord.command.harness-reload').pipe(
              Effect.annotateLogs({
                component: 'discord',
                connectionId: discordConfig.connectionId,
                conversationId: event.channel.id,
                userId: event.user.userId,
                outcome: outcome.ok ? 'reloaded' : outcome.reason,
              }),
            )
          }).pipe(
            Effect.catchCause((cause) => Effect.logError('Harness slash command failed', cause)),
          )
        chat.onSlashCommand(HARNESS_COMMAND_PATHS, (event) =>
          Effect.runPromise(runHarnessCommand(event)).then(() => undefined),
        )
        yield* startChatSdkLifecycle({
          connectionId: discordConfig.connectionId,
          chat,
          normalizeInboundMessage: (thread, message) =>
            projectDiscordMessage(discordConfig.connectionId, discord, thread, message),
          shouldHandleMessage: (kind, thread, message) =>
            Effect.try({
              try: () => {
                // Thread ids encode the parent channel, so policy resolves from
                // the parent channel while the message stays in its thread.
                const location = discord.decodeThreadId(thread.id)
                const resolved = resolveDiscordChannelPolicy(
                  currentPolicies(),
                  location.guildId,
                  location.channelId,
                )
                return { location, resolved }
              },
              catch: (cause) => new ChatSdkCallbackError({ operation: 'inbound-message', cause }),
            }).pipe(
              Effect.flatMap(({ location, resolved }) =>
                Effect.gen(function* () {
                  if (
                    Option.isNone(resolved) ||
                    !isAllowedByPolicy(message.author.userId, resolved.value.users)
                  ) {
                    return {
                      allowed: false,
                      location,
                      mode: null satisfies InvocationMode | null,
                    }
                  }
                  const input = yield* projectDiscordMessage(
                    discordConfig.connectionId,
                    discord,
                    thread,
                    message,
                  )
                  const hasBinding = yield* ingestion.hasBinding(input)
                  return {
                    allowed: shouldInvoke({
                      kind,
                      mode: resolved.value.invocationMode,
                      hasBinding,
                    }),
                    location,
                    mode: resolved.value.invocationMode,
                  }
                }).pipe(
                  Effect.mapError(
                    (cause) => new ChatSdkCallbackError({ operation: 'inbound-message', cause }),
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
            ingestion.ingest(input, bootstrap, (contextInput, cursor) => {
              const location = discord.decodeThreadId(String(contextInput.binding.conversationId))
              const policy = resolveChannelPolicy(location.guildId, location.channelId)
              return policy !== undefined &&
                shouldLoadDiscordContext({
                  created: cursor.created,
                  invocationMode: policy.invocationMode,
                  replyMode: policy.replyMode,
                })
                ? loadDiscordInitialContext(
                    discord,
                    config.current().agent.recentMessageCount,
                    contextInput,
                    cursor,
                  )
                : Effect.succeed(contextInput)
            }),
        })
        // Register the application commands before the gateway starts so a
        // registration failure cannot leave partially started Discord resources.
        yield* registerGlobalDiscordCommands({
          botToken,
          applicationId: String(discordConfig.credentials.applicationId),
        })
        yield* startDiscordGateway(discord)
        yield* Effect.logInfo('discord.started').pipe(
          Effect.annotateLogs({
            component: 'discord',
            connectionId: discordConfig.connectionId,
            userAccessMode: discordConfig.users.mode,
            userAccessCount: discordConfig.users.ids.length,
            guildCount: discordConfig.guilds.length,
            enabledGuildCount: discordConfig.guilds.filter((guild) => guild.enabled).length,
          }),
        )
        return { connectionId: discordConfig.connectionId, platform: chatSdkPlatform }
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
