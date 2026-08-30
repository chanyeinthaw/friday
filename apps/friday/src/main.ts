/* oxlint-disable effecttsgo/process-env, effecttsgo/strict-effect-provide -- This executable is the application entry point, provides the complete live layer once, and selects the bootstrap log level from NODE_ENV. */

import { BunRuntime } from '@effect/platform-bun'
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

import {
  FRIDAY_BIN_DIRECTORY,
  FRIDAY_CLI_PATH,
  FRIDAY_LOG_DIRECTORY,
  FRIDAY_LOG_PATH,
} from './FridayHome.ts'
import { ensureRepositoryWorktree } from './repositories/RepositoryWorktrees.ts'
import { runFridayCli } from './Cli.ts'
import { FridayLive } from './Live.ts'
import { withFridayLogging } from './logging/Live.ts'
import { startDiscord } from './platforms/discord/DiscordLive.ts'
import { FridaySqliteLive } from './persistence/Live.ts'

const start = Effect.scoped(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    yield* fileSystem.makeDirectory(FRIDAY_BIN_DIRECTORY, { recursive: true })
    yield* fileSystem.writeFileString(
      FRIDAY_CLI_PATH,
      `#!/usr/bin/env sh\nexec "${process.execPath}" "${import.meta.filename}" "$@"\n`,
    )
    yield* fileSystem.chmod(FRIDAY_CLI_PATH, 0o755)
    yield* startDiscord().pipe(Effect.provide(FridaySqliteLive))
    yield* Effect.logInfo('application.started').pipe(
      Effect.annotateLogs({
        component: 'application',
        logPath: FRIDAY_LOG_PATH,
      }),
    )
    return yield* Effect.never
  }),
).pipe(Effect.provide(FridayLive))

const application = Effect.scoped(
  withFridayLogging(
    runFridayCli(process.argv.slice(2), {
      start,
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
