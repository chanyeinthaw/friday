/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- Fake SQL row payloads are decoded immediately by the config schema; the fake client is a test double cast to the full SqlClient interface. */

import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Logger from 'effect/Logger'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { AppConfigError } from './AppConfig.ts'
import { AppConfig, makeAppConfigLive } from './AppConfigLive.ts'

/** Emulates a database failure inside the fake SQL client. */
class FakeSqlFailure extends Schema.TaggedError<FakeSqlFailure>()('FakeSqlFailure', {}) {}

const isAppConfigError = Schema.is(AppConfigError)

// Distinct from any ambient process.env variable: a mutant that ignores the
// injected environment and falls back to `process.env` cannot pass by accident.
const INJECTED_TOKEN_ENV = 'FRIDAY_TEST_INJECTED_TOKEN'

interface ConfigState {
  connectionName: string
  readonly admins: Set<string>
  /** When set, every statement fails with this message like a broken database. */
  failAll?: string
}

const initialConfigState = (): ConfigState => ({ connectionName: 'Personal', admins: new Set() })

/**
 * In-memory SqlClient answering only the statements `loadAppConfig` issues;
 * migration and setup statements succeed without state. SAFETY: the fake is
 * cast to the full client interface; the config layer only uses the statement
 * constructor and `withTransaction`.
 */
const fakeSqlClient = (state: ConfigState): SqlClient.SqlClient => {
  const rows = (query: string): ReadonlyArray<Record<string, unknown>> => {
    if (query.includes('FROM installation_config')) return [{ installation_id: 'installation-1' }]
    if (query.includes('FROM agent_config WHERE')) {
      return [
        {
          primary_provider: 'openai-multi',
          primary_model_id: 'gpt-5.6-terra',
          primary_thinking_level: 'medium',
          utility_provider: 'openai-multi',
          utility_model_id: 'gpt-5.6-terra',
          utility_thinking_level: 'medium',
          recent_message_count: 20,
        },
      ]
    }
    if (query.includes('FROM subagent_profiles')) {
      return [
        {
          name: 'primary',
          description: 'Primary profile',
          provider: 'openai-multi',
          model_id: 'gpt-5.6-terra',
          thinking_level: 'medium',
        },
      ]
    }
    if (query.includes('JOIN discord_connections')) {
      return [
        {
          connection_id: 'discord-personal',
          name: state.connectionName,
          application_id: 'application-id',
          public_key: 'public-key',
          bot_token_env: INJECTED_TOKEN_ENV,
          respond_to_global_mentions: 0,
          activity_description_public: 0,
        },
      ]
    }
    if (query.includes('SELECT user_id FROM admin_discord_users')) {
      return [...state.admins].sort().map((user_id) => ({ user_id }))
    }
    // Invocation defaults, channel policies, system channels, mention roles,
    // access policies/subjects, and migrations all return no rows.
    return []
  }
  const client = ((
    strings: TemplateStringsArray,
  ): Effect.Effect<ReadonlyArray<Record<string, unknown>>, Error> =>
    state.failAll !== undefined
      ? Effect.fail(new FakeSqlFailure())
      : Effect.succeed(rows(strings.join('?')))) as unknown as SqlClient.SqlClient
  return Object.assign(client, {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
  })
}

const configLayer = (state: ConfigState, environment: Record<string, string | undefined>) =>
  makeAppConfigLive({ environment }).pipe(
    Layer.provide(Layer.succeed(SqlClient.SqlClient, fakeSqlClient(state))),
  )

describe('AppConfigLive environment injection', () => {
  it.effect('resolves secrets from the injected environment at startup', () =>
    Effect.gen(function* () {
      const config = yield* AppConfig
      const snapshot = config.current()
      assert.strictEqual(snapshot.platforms.discord[0]?.credentials.botToken, 'injected-token')
    }).pipe(
      Effect.provide(configLayer(initialConfigState(), { [INJECTED_TOKEN_ENV]: 'injected-token' })),
    ),
  )

  it.effect('fails to start when the injected environment lacks the secret', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Effect.gen(function* () {
          yield* AppConfig
        }).pipe(Effect.provide(configLayer(initialConfigState(), {}))),
      )
      assert(isAppConfigError(error))
      assert.strictEqual(error.operation, 'secret')
    }),
  )

  it.effect('reloads with the injected environment and retains the snapshot on failure', () => {
    // Shared with the fake client so the test can corrupt stored rows.
    const state = initialConfigState()
    const logs: Array<{ message: unknown; annotations: Record<string, unknown> }> = []
    const captureLogger = Logger.map(Logger.formatStructured, (output) => {
      logs.push({ message: output.message, annotations: output.annotations })
    })
    return Effect.gen(function* () {
      const config = yield* AppConfig

      assert.strictEqual(yield* config.reload, 2)
      const running = config.current()
      assert.strictEqual(running.platforms.discord[0]?.credentials.botToken, 'injected-token')

      // Corrupt the stored connection name: valid for SQLite, invalid for the
      // config schema. The failed reload retains the previous snapshot object
      // and reports the failure as a structured warning log.
      state.connectionName = ''
      const error = yield* Effect.flip(config.reload)
      assert(isAppConfigError(error))
      assert.strictEqual(config.current(), running)

      const failureLog = logs.find((log) => log.message === 'config.reload.failed')
      assert(failureLog !== undefined)
      assert.strictEqual(failureLog.annotations.detail, error.detail)
      assert.strictEqual(failureLog.annotations.path, error.path)

      state.connectionName = 'Personal'
      assert.strictEqual(yield* config.reload, 3)
    }).pipe(
      Effect.provide(configLayer(state, { [INJECTED_TOKEN_ENV]: 'injected-token' })),
      Effect.provide(Logger.layer([captureLogger], { mergeWithExisting: true })),
    )
  })

  it.effect('wraps non-config database failures into AppConfigError', () => {
    const state = initialConfigState()
    return Effect.gen(function* () {
      const config = yield* AppConfig
      const running = config.current()

      state.failAll = 'database is broken'
      const error = yield* Effect.flip(config.reload)
      assert(isAppConfigError(error))
      assert.strictEqual(error.operation, 'read')
      assert.strictEqual(error.path, 'database')
      assert.strictEqual(config.current(), running)
    }).pipe(Effect.provide(configLayer(state, { [INJECTED_TOKEN_ENV]: 'injected-token' })))
  })
})
