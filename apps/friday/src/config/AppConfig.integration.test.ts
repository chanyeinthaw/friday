/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function, effecttsgo/strict-effect-provide -- Bun runs SQLite integration tests; Effect execution is the explicit test boundary. */

import { test } from 'bun:test'
import { PlatformConnectionId } from '@friday/contracts/conversation'
import { strict as assert } from 'node:assert'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { AppConfigError, loadAppConfig } from './AppConfig.ts'
import { AppConfig, AppConfigLive } from './AppConfigLive.ts'
import { runMigrations } from '../persistence/Migrations.ts'
import {
  DiscordActivityDescriptions,
  DiscordActivityDescriptionsLive,
} from '../platforms/DiscordActivityDescriptions.ts'

const database = SqliteClient.layer({ filename: ':memory:' })
const isAppConfigError = Schema.is(AppConfigError)
const decodePlatformConnectionId = Schema.decodeSync(PlatformConnectionId)

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
  yield* sql`
    INSERT INTO platform_system_channels (connection_id, channel_id, created_at, updated_at)
    VALUES ('discord-personal', 'system-channel', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `
  yield* sql`
    UPDATE platform_invocation_defaults
    SET mode = 'mention-only'
    WHERE connection_id = 'discord-personal'
  `
  yield* sql`
    INSERT INTO platform_channel_invocation_policies (connection_id, channel_id, mode)
    VALUES ('discord-personal', 'channel-1', 'all-messages')
  `
  return yield* loadAppConfig({ environment: { DISCORD_BOT_TOKEN: 'discord-token' } })
})

test('loads global agent configuration and enabled platform connections from SQLite', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* configured
      assert(config.installationId.length > 0)
      yield* runMigrations()
      const reloaded = yield* loadAppConfig({ environment: { DISCORD_BOT_TOKEN: 'discord-token' } })
      assert.strictEqual(reloaded.installationId, config.installationId)
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
      assert.strictEqual(discord.activityDescription, false)
      assert.deepStrictEqual(discord.systemChannelIds, ['system-channel'])
      assert.deepStrictEqual(discord.invocation, {
        defaultMode: 'mention-only',
        channels: [{ channelId: 'channel-1', mode: 'all-messages' }],
      })
    }).pipe(Effect.provide(database)),
  ))

test('enables and resets Discord activity-description publication through typed configuration', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
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
          'discord-personal', 'application-id', 'public-key', 'DISCORD_BOT_TOKEN', 0
        )
      `
      const descriptions = yield* DiscordActivityDescriptions
      yield* descriptions.set(decodePlatformConnectionId('discord-personal'))
      const enabled = yield* loadAppConfig({
        environment: { DISCORD_BOT_TOKEN: 'discord-token' },
      })
      assert.strictEqual(enabled.platforms.discord[0]?.activityDescription, true)

      yield* descriptions.reset(decodePlatformConnectionId('discord-personal'))
      const reset = yield* loadAppConfig({
        environment: { DISCORD_BOT_TOKEN: 'discord-token' },
      })
      assert.strictEqual(reset.platforms.discord[0]?.activityDescription, false)
    }).pipe(Effect.provide(DiscordActivityDescriptionsLive), Effect.provide(database)),
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

// Reload tests share one seeded database per runtime: the seed layer runs before
// AppConfigLive builds its initial snapshot.
const reloadable = AppConfigLive.pipe(
  Layer.provide(database),
  Layer.provide(Layer.effectDiscard(configured)),
)

test('reloads the complete configuration and bumps the snapshot version', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* AppConfig
      const first = config.current()
      assert.strictEqual(first.platforms.discord[0]?.systemChannelIds[0], 'system-channel')

      const sql = yield* SqlClient.SqlClient
      yield* sql`
        INSERT INTO platform_system_channels (connection_id, channel_id, created_at, updated_at)
        VALUES ('discord-personal', 'system-channel-2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `
      const version = yield* config.reload
      assert.strictEqual(version, 2)
      const second = config.current()
      assert.deepStrictEqual(second.platforms.discord[0]?.systemChannelIds, [
        'system-channel',
        'system-channel-2',
      ])
      assert.strictEqual(second.agent.recentMessageCount, first.agent.recentMessageCount)
    }).pipe(Effect.provide(reloadable), Effect.provide(database)),
  ))

test('retains the previous snapshot when a reload fails validation', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* AppConfig
      const sql = yield* SqlClient.SqlClient
      const before = config.current()

      // Empty the connection name: valid for SQLite, invalid for the config schema.
      yield* sql`
        UPDATE platform_connections SET name = '' WHERE connection_id = 'discord-personal'
      `
      const error = yield* Effect.flip(config.reload)
      assert(isAppConfigError(error))
      // The failed reload retained the previous snapshot object unchanged.
      assert.strictEqual(config.current(), before)

      yield* sql`
        UPDATE platform_connections SET name = 'Personal Discord'
        WHERE connection_id = 'discord-personal'
      `
      const version = yield* config.reload
      assert.strictEqual(version, 2)
    }).pipe(Effect.provide(reloadable), Effect.provide(database)),
  ))

test('reload keeps startup Discord topology and admin allow-list pinned', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* AppConfig
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        DELETE FROM discord_mention_roles WHERE connection_id = 'discord-personal'
      `
      yield* sql`
        INSERT INTO admin_discord_users (user_id, created_at)
        VALUES ('admin-rotated', CURRENT_TIMESTAMP)
      `
      const version = yield* config.reload
      assert.strictEqual(version, 2)
      const reloaded = config.current()
      const connection = reloaded.platforms.discord[0]
      assert(connection)
      assert.deepStrictEqual([...connection.mentionRoleIds], ['role-1'])
      assert.deepStrictEqual([...reloaded.admin.discordUserIds], [])
      // Access policies stay reloadable.
      assert.strictEqual(connection.access.users.mode, 'all')
    }).pipe(Effect.provide(reloadable), Effect.provide(database)),
  ))
