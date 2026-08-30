/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function, effecttsgo/strict-effect-provide -- Bun runs SQLite integration tests; Effect execution is the explicit test boundary. */

import { test } from 'bun:test'
import { strict as assert } from 'node:assert'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { AppConfigError, loadAppConfig } from './AppConfig.ts'
import { runMigrations } from '../persistence/Migrations.ts'

const database = SqliteClient.layer({ filename: ':memory:' })
const isAppConfigError = Schema.is(AppConfigError)

const configured = Effect.gen(function* () {
  yield* runMigrations()
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    INSERT INTO platform_connections (
      connection_id, platform, name, enabled, created_at, updated_at
    ) VALUES (
      'discord-personal', 'discord', 'Personal Discord', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `
  yield* sql`
    INSERT INTO discord_connections (
      connection_id, application_id, public_key, bot_token_env, respond_to_global_mentions
    ) VALUES (
      'discord-personal', 'application-id', 'public-key', 'DISCORD_BOT_TOKEN', 1
    )
  `
  yield* sql`
    INSERT INTO platform_access_policies (connection_id, subject_type, mode)
    VALUES
      ('discord-personal', 'user', 'all'),
      ('discord-personal', 'channel', 'allow'),
      ('discord-personal', 'guild', 'deny')
  `
  yield* sql`
    INSERT INTO platform_access_subjects (connection_id, subject_type, platform_subject_id)
    VALUES
      ('discord-personal', 'channel', 'channel-1'),
      ('discord-personal', 'guild', 'guild-1')
  `
  yield* sql`
    INSERT INTO discord_mention_roles (connection_id, role_id)
    VALUES ('discord-personal', 'role-1')
  `
  return yield* loadAppConfig({ environment: { DISCORD_BOT_TOKEN: 'discord-token' } })
})

test('loads global agent configuration and enabled platform connections from SQLite', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* configured
      assert.strictEqual(config.models.primary.provider, 'openai-multi')
      assert.strictEqual(config.models.primary.modelId, 'gpt-5.6-terra')
      assert.strictEqual(config.models.primary.thinkingLevel, 'medium')
      assert.strictEqual(config.models.utility.modelId, 'glm-5.3-flash')
      assert.strictEqual(config.models.subagents[0]?.name, 'primary')
      assert.strictEqual(config.agent.recentMessageCount, 20)

      const discord = config.platforms.discord[0]
      assert(discord !== undefined)
      assert.strictEqual(discord.connectionId, 'discord-personal')
      assert.strictEqual(discord.credentials.botToken, 'discord-token')
      assert.deepStrictEqual(discord.access.users, { mode: 'all', ids: [] })
      assert.deepStrictEqual(discord.access.channels, { mode: 'allow', ids: ['channel-1'] })
      assert.deepStrictEqual(discord.access.guilds, { mode: 'deny', ids: ['guild-1'] })
      assert.deepStrictEqual(discord.mentionRoleIds, ['role-1'])
      assert.strictEqual(discord.respondToGlobalMentions, true)
    }).pipe(Effect.provide(database)),
  ))

test('supports multiple connections for the same platform', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* runMigrations()
      const sql = yield* SqlClient.SqlClient
      yield* sql`
      INSERT INTO platform_connections (
        connection_id, platform, name, enabled, created_at, updated_at
      ) VALUES
        ('discord-a', 'discord', 'Discord A', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('discord-b', 'discord', 'Discord B', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `
      yield* sql`
      INSERT INTO discord_connections (
        connection_id, application_id, public_key, bot_token_env, respond_to_global_mentions
      ) VALUES
        ('discord-a', 'a', 'a', 'TOKEN_A', 0),
        ('discord-b', 'b', 'b', 'TOKEN_B', 0)
    `
      const config = yield* loadAppConfig({
        environment: { TOKEN_A: 'token-a', TOKEN_B: 'token-b' },
      })
      assert.deepStrictEqual(
        config.platforms.discord.map(({ connectionId }) => connectionId),
        ['discord-a', 'discord-b'],
      )
    }).pipe(Effect.provide(database)),
  ))

test('does not load disabled platform connections', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* runMigrations()
      const sql = yield* SqlClient.SqlClient
      yield* sql`
      INSERT INTO platform_connections (
        connection_id, platform, name, enabled, created_at, updated_at
      ) VALUES ('discord-disabled', 'discord', 'Disabled', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `
      yield* sql`
      INSERT INTO discord_connections (
        connection_id, application_id, public_key, bot_token_env, respond_to_global_mentions
      ) VALUES ('discord-disabled', 'a', 'b', 'MISSING_TOKEN', 0)
    `
      const config = yield* loadAppConfig({ environment: {} })
      assert.deepStrictEqual(config.platforms.discord, [])
    }).pipe(Effect.provide(database)),
  ))

test('fails safely when an enabled connection secret is missing', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* runMigrations()
      const sql = yield* SqlClient.SqlClient
      yield* sql`
      INSERT INTO platform_connections (
        connection_id, platform, name, enabled, created_at, updated_at
      ) VALUES ('discord-personal', 'discord', 'Personal', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `
      yield* sql`
      INSERT INTO discord_connections (
        connection_id, application_id, public_key, bot_token_env, respond_to_global_mentions
      ) VALUES ('discord-personal', 'a', 'b', 'DISCORD_BOT_TOKEN', 0)
    `
      const error = yield* Effect.flip(loadAppConfig({ environment: {} }))
      assert(isAppConfigError(error))
      assert.strictEqual(error.operation, 'secret')
      assert.strictEqual(error.path, 'platforms.discord-personal.credentials.botToken')
      assert(error.detail.includes('DISCORD_BOT_TOKEN'))
    }).pipe(Effect.provide(database)),
  ))
