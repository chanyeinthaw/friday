/* oxlint-disable effecttsgo/process-env, effecttsgo/strict-effect-provide -- This executable is the application entry point, provides the complete live layer once, and selects the bootstrap log level from NODE_ENV. */

import { BunRuntime } from '@effect/platform-bun'
import * as BunCrypto from '@effect/platform-bun/BunCrypto'
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'

import {
  FRIDAY_BIN_DIRECTORY,
  FRIDAY_CLI_PATH,
  FRIDAY_CONTROL_SOCKET_PATH,
  FRIDAY_LOG_DIRECTORY,
  FRIDAY_LOG_PATH,
  isPackagedBuild,
} from './FridayHome.ts'
import {
  ensureRepositoryWorktree,
  listManagedWorktrees,
} from './repositories/RepositoryWorktrees.ts'
import { runFridayCli } from './Cli.ts'
import { FridayLive } from './Live.ts'
import { withFridayLogging } from './logging/Live.ts'
import { reloadApplicationConfig } from './config/ConfigReload.ts'
import { sendControlRequest, serveControlSocket } from './control/ControlSocket.ts'
import { DiscordGuildError, DiscordGuilds, DiscordGuildsLive } from './config/DiscordGuilds.ts'
import { DiscordConnections, DiscordConnectionsLive } from './config/DiscordConnections.ts'
import {
  DiscordActivityDescriptions,
  DiscordActivityDescriptionsLive,
} from './platforms/DiscordActivityDescriptions.ts'
import { AppConfig } from './config/AppConfigLive.ts'
import { DiscordAdmins, DiscordAdminsLive } from './config/DiscordAdmins.ts'
import { ModelConfiguration, ModelConfigurationLive } from './config/ModelConfiguration.ts'
import { DiscordLinks, DiscordLinksLive } from './config/DiscordLinks.ts'
import { getPiModel, listPiModels, reloadPiModels } from './harness/pi/PiModelCatalog.ts'
import { startDiscord } from './platforms/discord/DiscordLive.ts'
import { FridaySqliteLive, ThreadPersistenceLive } from './persistence/Live.ts'
import { WorkspaceCleanup, WorkspaceCleanupLive } from './workspaces/WorkspaceCleanup.ts'
import {
  WorkspaceCleanupNotifications,
  WorkspaceCleanupNotificationsLive,
} from './workspaces/WorkspaceCleanupNotifications.ts'

const WorkspaceCleanupConfiguredLive = WorkspaceCleanupLive.pipe(
  Layer.provide(Layer.merge(FridaySqliteLive, ThreadPersistenceLive)),
)
const WorkspaceCleanupNotificationsConfiguredLive = WorkspaceCleanupNotificationsLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      WorkspaceCleanupConfiguredLive,
      FridayLive,
      FridaySqliteLive,
      ThreadPersistenceLive,
    ),
  ),
)

const DiscordActivityDescriptionsConfiguredLive = DiscordActivityDescriptionsLive.pipe(
  Layer.provide(FridaySqliteLive),
)
const DiscordGuildsConfiguredLive = DiscordGuildsLive.pipe(Layer.provide(FridaySqliteLive))
const DiscordConnectionsConfiguredLive = DiscordConnectionsLive.pipe(
  Layer.provide(FridaySqliteLive),
)
const DiscordAdminsConfiguredLive = DiscordAdminsLive.pipe(Layer.provide(FridaySqliteLive))
const ModelConfigurationConfiguredLive = ModelConfigurationLive.pipe(
  Layer.provide(FridaySqliteLive),
)
const DiscordLinksConfiguredLive = DiscordLinksLive.pipe(Layer.provide(FridaySqliteLive))

const start = Effect.scoped(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    if (!isPackagedBuild) {
      yield* fileSystem.makeDirectory(FRIDAY_BIN_DIRECTORY, { recursive: true })
      yield* fileSystem.writeFileString(
        FRIDAY_CLI_PATH,
        `#!/usr/bin/env sh\nexec "${process.execPath}" "${import.meta.filename}" "$@"\n`,
      )
      yield* fileSystem.chmod(FRIDAY_CLI_PATH, 0o755)
    }
    const config = yield* AppConfig
    yield* serveControlSocket({
      path: FRIDAY_CONTROL_SOCKET_PATH,
      reload: reloadApplicationConfig(config),
    })
    yield* startDiscord().pipe(Effect.provide(FridaySqliteLive))
    const cleanupNotifications = yield* WorkspaceCleanupNotifications
    yield* cleanupNotifications.run.pipe(Effect.forkScoped)
    yield* Effect.logInfo('application.started').pipe(
      Effect.annotateLogs({
        component: 'application',
        logPath: FRIDAY_LOG_PATH,
      }),
    )
    return yield* Effect.never
  }),
).pipe(Effect.provide(WorkspaceCleanupNotificationsConfiguredLive), Effect.provide(FridayLive))

const application = Effect.scoped(
  withFridayLogging(
    runFridayCli(process.argv.slice(2), {
      start,
      reloadConfig: sendControlRequest(FRIDAY_CONTROL_SOCKET_PATH, { op: 'config.reload' }),
      listConfiguredModels: () =>
        ModelConfiguration.pipe(
          Effect.flatMap((service) => service.listModels()),
          Effect.provide(ModelConfigurationConfiguredLive),
        ),
      getConfiguredModel: (name) =>
        ModelConfiguration.pipe(
          Effect.flatMap((service) => service.getModel(name)),
          Effect.provide(ModelConfigurationConfiguredLive),
        ),
      setConfiguredModel: (selection) =>
        ModelConfiguration.pipe(
          Effect.flatMap((service) => service.setModel(selection)),
          Effect.provide(ModelConfigurationConfiguredLive),
        ),
      listSubagentProfiles: () =>
        ModelConfiguration.pipe(
          Effect.flatMap((service) => service.listProfiles()),
          Effect.provide(ModelConfigurationConfiguredLive),
        ),
      getSubagentProfile: (name) =>
        ModelConfiguration.pipe(
          Effect.flatMap((service) => service.getProfile(name)),
          Effect.provide(ModelConfigurationConfiguredLive),
        ),
      addSubagentProfile: (profile) =>
        ModelConfiguration.pipe(
          Effect.flatMap((service) => service.addProfile(profile)),
          Effect.provide(ModelConfigurationConfiguredLive),
        ),
      updateSubagentProfile: (patch) =>
        ModelConfiguration.pipe(
          Effect.flatMap((service) => service.updateProfile(patch)),
          Effect.provide(ModelConfigurationConfiguredLive),
        ),
      removeSubagentProfile: (name) =>
        ModelConfiguration.pipe(
          Effect.flatMap((service) => service.removeProfile(name)),
          Effect.provide(ModelConfigurationConfiguredLive),
        ),
      listPiModels,
      getPiModel,
      reloadPiModels,
      setDiscordLink: (link) =>
        DiscordLinks.pipe(
          Effect.flatMap((links) => links.set(link)),
          Effect.mapError((cause) => new DiscordGuildError({ operation: 'write', cause })),
          Effect.provide(DiscordLinksConfiguredLive),
        ),
      getDiscordLink: (id) =>
        DiscordLinks.pipe(
          Effect.flatMap((links) => links.get(id)),
          Effect.mapError((cause) => new DiscordGuildError({ operation: 'read', cause })),
          Effect.provide(DiscordLinksConfiguredLive),
        ),
      listDiscordLinks: () =>
        DiscordLinks.pipe(
          Effect.flatMap((links) => links.list()),
          Effect.mapError((cause) => new DiscordGuildError({ operation: 'read', cause })),
          Effect.provide(DiscordLinksConfiguredLive),
        ),
      enableDiscordLink: (id) =>
        DiscordLinks.pipe(
          Effect.flatMap((links) => links.enable(id)),
          Effect.mapError((cause) => new DiscordGuildError({ operation: 'write', cause })),
          Effect.provide(DiscordLinksConfiguredLive),
        ),
      disableDiscordLink: (id) =>
        DiscordLinks.pipe(
          Effect.flatMap((links) => links.disable(id)),
          Effect.mapError((cause) => new DiscordGuildError({ operation: 'write', cause })),
          Effect.provide(DiscordLinksConfiguredLive),
        ),
      removeDiscordLink: (id) =>
        DiscordLinks.pipe(
          Effect.flatMap((links) => links.remove(id)),
          Effect.mapError((cause) => new DiscordGuildError({ operation: 'write', cause })),
          Effect.provide(DiscordLinksConfiguredLive),
        ),
      setDiscordActivityDescription: (action, enabled) =>
        DiscordActivityDescriptions.pipe(
          Effect.flatMap((descriptions) =>
            enabled
              ? descriptions.set(action.connectionId)
              : descriptions.reset(action.connectionId),
          ),
          Effect.provide(DiscordActivityDescriptionsConfiguredLive),
        ),
      updateDiscordConnection: (action) =>
        DiscordConnections.pipe(
          Effect.flatMap((connections) => connections.updateConnection(action)),
          Effect.provide(DiscordConnectionsConfiguredLive),
        ),
      addDiscordConnection: (input) =>
        DiscordConnections.pipe(
          Effect.flatMap((connections) => connections.addConnection(input)),
          Effect.provide(DiscordConnectionsConfiguredLive),
        ),
      removeDiscordConnection: (connectionId) =>
        DiscordConnections.pipe(
          Effect.flatMap((connections) => connections.removeConnection(connectionId)),
          Effect.provide(DiscordConnectionsConfiguredLive),
        ),
      enableDiscordConnection: (connectionId) =>
        DiscordConnections.pipe(
          Effect.flatMap((connections) => connections.enableConnection(connectionId)),
          Effect.provide(DiscordConnectionsConfiguredLive),
        ),
      disableDiscordConnection: (connectionId) =>
        DiscordConnections.pipe(
          Effect.flatMap((connections) => connections.disableConnection(connectionId)),
          Effect.provide(DiscordConnectionsConfiguredLive),
        ),
      getDiscordConnection: (connectionId) =>
        DiscordConnections.pipe(
          Effect.flatMap((connections) => connections.getConnection(connectionId)),
          Effect.provide(DiscordConnectionsConfiguredLive),
        ),
      listDiscordConnections: () =>
        DiscordConnections.pipe(
          Effect.flatMap((connections) => connections.listConnections()),
          Effect.provide(DiscordConnectionsConfiguredLive),
        ),
      listDiscordGuilds: (connectionId) =>
        DiscordGuilds.pipe(
          Effect.flatMap((guilds) => guilds.listGuilds(connectionId)),
          Effect.provide(DiscordGuildsConfiguredLive),
        ),
      enableDiscordGuild: (connectionId, guildId) =>
        DiscordGuilds.pipe(
          Effect.flatMap((guilds) => guilds.enableGuild(connectionId, guildId)),
          Effect.provide(DiscordGuildsConfiguredLive),
        ),
      disableDiscordGuild: (connectionId, guildId) =>
        DiscordGuilds.pipe(
          Effect.flatMap((guilds) => guilds.disableGuild(connectionId, guildId)),
          Effect.provide(DiscordGuildsConfiguredLive),
        ),
      removeDiscordGuild: (connectionId, guildId) =>
        DiscordGuilds.pipe(
          Effect.flatMap((guilds) => guilds.removeGuild(connectionId, guildId)),
          Effect.provide(DiscordGuildsConfiguredLive),
        ),
      setDiscordGuildInvocation: (connectionId, guildId, mode) =>
        DiscordGuilds.pipe(
          Effect.flatMap((guilds) => guilds.setGuildInvocation(connectionId, guildId, mode)),
          Effect.provide(DiscordGuildsConfiguredLive),
        ),
      setDiscordGuildUsers: (connectionId, guildId, policy) =>
        DiscordGuilds.pipe(
          Effect.flatMap((guilds) => guilds.setGuildUsers(connectionId, guildId, policy)),
          Effect.provide(DiscordGuildsConfiguredLive),
        ),
      setDiscordGuildChannels: (connectionId, guildId, policy) =>
        DiscordGuilds.pipe(
          Effect.flatMap((guilds) => guilds.setGuildChannelScope(connectionId, guildId, policy)),
          Effect.provide(DiscordGuildsConfiguredLive),
        ),
      setDiscordGuildChannel: (connectionId, guildId, channelId, patch) =>
        DiscordGuilds.pipe(
          Effect.flatMap((guilds) => guilds.setChannel(connectionId, guildId, channelId, patch)),
          Effect.provide(DiscordGuildsConfiguredLive),
        ),
      resetDiscordGuildChannel: (connectionId, guildId, channelId) =>
        DiscordGuilds.pipe(
          Effect.flatMap((guilds) => guilds.resetChannel(connectionId, guildId, channelId)),
          Effect.provide(DiscordGuildsConfiguredLive),
        ),
      addDiscordAdmin: (userId) =>
        DiscordAdmins.pipe(
          Effect.flatMap((admins) => admins.add(userId)),
          Effect.provide(DiscordAdminsConfiguredLive),
        ),
      removeDiscordAdmin: (userId) =>
        DiscordAdmins.pipe(
          Effect.flatMap((admins) => admins.remove(userId)),
          Effect.provide(DiscordAdminsConfiguredLive),
        ),
      listDiscordAdmins: () =>
        DiscordAdmins.pipe(
          Effect.flatMap((admins) => admins.list()),
          Effect.provide(DiscordAdminsConfiguredLive),
        ),
      applyWorkspaceCleanup: (action, currentWorkingDirectory) =>
        WorkspaceCleanup.pipe(
          Effect.flatMap((cleanup) => cleanup.apply(action.proposalId, currentWorkingDirectory)),
          Effect.provide(WorkspaceCleanupLive),
          Effect.provide(ThreadPersistenceLive),
          Effect.provide(FridaySqliteLive),
          Effect.provide(BunFileSystem.layer),
          Effect.provide(BunCrypto.layer),
        ),
      listWorkspaceCleanupProposals: () =>
        WorkspaceCleanup.pipe(
          Effect.flatMap((cleanup) => cleanup.list()),
          Effect.provide(WorkspaceCleanupLive),
          Effect.provide(ThreadPersistenceLive),
          Effect.provide(FridaySqliteLive),
          Effect.provide(BunFileSystem.layer),
          Effect.provide(BunCrypto.layer),
        ),
      listWorktrees: () => listManagedWorktrees(),
      ensureWorktree: (action) => {
        const workspaceRoot = action.workspace ?? process.env.FRIDAY_WORKSPACE_ROOT ?? process.cwd()
        return action.ref === undefined
          ? ensureRepositoryWorktree({ url: action.url, workspaceRoot })
          : ensureRepositoryWorktree({ url: action.url, workspaceRoot, ref: action.ref })
      },
    }).pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logFatal(cause).pipe(
              Effect.annotateLogs({
                component: 'application',
                event: 'application.failed',
              }),
            ),
      ),
    ),
    {
      directory: FRIDAY_LOG_DIRECTORY,
      path: FRIDAY_LOG_PATH,
      minimumLevel: process.env.NODE_ENV === 'development' ? 'Debug' : 'Info',
    },
  ),
).pipe(Effect.provide(BunFileSystem.layer))

BunRuntime.runMain(application, { disableErrorReporting: true })
