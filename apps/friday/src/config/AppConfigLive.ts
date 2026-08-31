import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as MutableRef from 'effect/MutableRef'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import {
  loadAppConfig,
  mergeReloadedAppConfig,
  AppConfigError,
  type AppConfig as AppConfigData,
} from './AppConfig.ts'
import { runMigrations } from '../persistence/Migrations.ts'

export interface AppConfigSnapshot {
  /** Monotonic snapshot version; incremented on every successful reload. */
  readonly version: number
  readonly config: AppConfigData
}

export interface AppConfigContract {
  /**
   * Synchronous read of the current validated snapshot. Reads never touch SQLite;
   * transports may call this on every message. The initial snapshot is loaded and
   * validated once when the layer is constructed.
   */
  readonly current: () => AppConfigData
  /**
   * Loads and validates the complete SQLite configuration, then atomically swaps
   * it into the running snapshot. On failure the previous snapshot is retained.
   * Discord connection topology and the admin allow-list stay pinned to the
   * running snapshot; changing them requires a restart.
   */
  readonly reload: Effect.Effect<number, AppConfigError>
}

export class AppConfig extends Context.Service<AppConfig, AppConfigContract>()(
  'friday/config/AppConfig',
) {}

const isAppConfigError = Schema.is(AppConfigError)

export const AppConfigLive = Layer.effect(
  AppConfig,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* runMigrations()
    const initial = yield* loadAppConfig()
    const snapshot = MutableRef.make<AppConfigSnapshot>({ version: 1, config: initial })
    // Serializes reload loads so concurrent swaps cannot regress the version.
    const reloadLock = yield* Semaphore.make(1)

    return AppConfig.of({
      current: () => MutableRef.get(snapshot).config,
      reload: reloadLock
        .withPermits(1)(
          Effect.gen(function* () {
            const running = MutableRef.get(snapshot)
            const loaded = yield* loadAppConfig().pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              // Keep the reload contract typed: persistence failures become
              // AppConfigError, and a failed load never touches the snapshot.
              Effect.catch((cause) =>
                isAppConfigError(cause)
                  ? Effect.fail(cause)
                  : Effect.fail(
                      new AppConfigError({
                        operation: 'read',
                        path: 'database',
                        detail: String(cause),
                        cause,
                      }),
                    ),
              ),
            )
            const next: AppConfigSnapshot = {
              version: running.version + 1,
              config: mergeReloadedAppConfig(running.config, loaded),
            }
            // Atomic swap: concurrent readers observe either the previous or the
            // next complete snapshot, never a partially built configuration.
            MutableRef.set(next)(snapshot)
            return next.version
          }),
        )
        .pipe(
          Effect.tapError((cause) =>
            Effect.logWarning('config.reload.failed').pipe(
              Effect.annotateLogs({ detail: cause.detail, path: cause.path }),
            ),
          ),
        ),
    })
  }),
)
