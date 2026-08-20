/* oxlint-disable effecttsgo/strict-effect-provide -- This helper installs the logger layer around the complete application or test scope supplied by its caller. */

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Logger from 'effect/Logger'
import type * as PlatformError from 'effect/PlatformError'
import * as References from 'effect/References'
import type * as Scope from 'effect/Scope'

export interface FridayLoggingOptions {
  readonly directory: string
  readonly path: string
  readonly minimumLevel?: 'Debug' | 'Info'
}

export const withFridayLogging = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: FridayLoggingOptions,
): Effect.Effect<A, E | PlatformError.PlatformError, R | FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    yield* fileSystem
      .makeDirectory(options.directory, { recursive: true })
      .pipe(
        Effect.tapError((cause) =>
          Effect.logFatal('application.logging.failed', cause).pipe(
            Effect.annotateLogs({ component: 'application', operation: 'create-log-directory' }),
          ),
        ),
      )
    const fileLogger = yield* Logger.toFile(Logger.formatJson, options.path).pipe(
      Effect.tapError((cause) =>
        Effect.logFatal('application.logging.failed', cause).pipe(
          Effect.annotateLogs({ component: 'application', operation: 'open-log-file' }),
        ),
      ),
    )

    return yield* effect.pipe(
      Effect.provide(
        Logger.layer([fileLogger], {
          mergeWithExisting: true,
        }),
      ),
      Effect.provideService(References.MinimumLogLevel, options.minimumLevel ?? 'Info'),
    )
  })
