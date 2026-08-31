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
  FRIDAY_LOG_DIRECTORY,
  FRIDAY_LOG_PATH,
  isPackagedBuild,
} from './FridayHome.ts'
import { ensureRepositoryWorktree } from './repositories/RepositoryWorktrees.ts'
import { runFridayCli } from './Cli.ts'
import { FridayLive } from './Live.ts'
import { withFridayLogging } from './logging/Live.ts'
import { InvocationPolicies, InvocationPoliciesLive } from './platforms/InvocationPolicies.ts'
import {
  DiscordActivityDescriptions,
  DiscordActivityDescriptionsLive,
} from './platforms/DiscordActivityDescriptions.ts'
import { SystemChannels, SystemChannelsLive } from './platforms/SystemChannels.ts'
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

const InvocationPoliciesConfiguredLive = InvocationPoliciesLive.pipe(
  Layer.provide(FridaySqliteLive),
)
const DiscordActivityDescriptionsConfiguredLive = DiscordActivityDescriptionsLive.pipe(
  Layer.provide(FridaySqliteLive),
)
const SystemChannelsConfiguredLive = SystemChannelsLive.pipe(Layer.provide(FridaySqliteLive))

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
      setDiscordActivityDescription: (action, enabled) =>
        DiscordActivityDescriptions.pipe(
          Effect.flatMap((descriptions) =>
            enabled
              ? descriptions.set(action.connectionId)
              : descriptions.reset(action.connectionId),
          ),
          Effect.provide(DiscordActivityDescriptionsConfiguredLive),
        ),
      setPlatformSystemChannel: (action, enabled) =>
        SystemChannels.pipe(
          Effect.flatMap((channels) =>
            enabled
              ? channels.set(action.connectionId, action.channelId)
              : channels.reset(action.connectionId, action.channelId),
          ),
          Effect.provide(SystemChannelsConfiguredLive),
        ),
      setPlatformInvocation: (action) =>
        InvocationPolicies.pipe(
          Effect.flatMap((policies) =>
            policies.setChannelMode({
              connectionId: action.connectionId,
              channelId: action.channelId,
              mode: action.mode,
            }),
          ),
          Effect.provide(InvocationPoliciesConfiguredLive),
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
