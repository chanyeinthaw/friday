/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, anti-slop/no-unsafe-dictionary-type -- Bun executes the SQLite integration boundary; SQL rows are decoded immediately. */

import { test } from 'bun:test'
import { PlatformConnectionId } from '@friday/contracts/conversation'
import { strict as assert } from 'node:assert'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { InvocationMode, type InvocationMode as InvocationModeType } from './AppConfig.ts'
import { loadAppConfig } from './AppConfig.ts'
import {
  DiscordGuildChannelId,
  DiscordGuildError,
  DiscordGuildId,
  DiscordGuilds,
  DiscordGuildsLive,
} from './DiscordGuilds.ts'
import { runMigrations } from '../persistence/Migrations.ts'

const database = SqliteClient.layer({ filename: ':memory:' })
const guilds = DiscordGuildsLive.pipe(Layer.provide(database))
const decodeGuildId = Schema.decodeSync(DiscordGuildId)
const decodeChannelId = Schema.decodeSync(DiscordGuildChannelId)
const decodeConnectionId = Schema.decodeSync(PlatformConnectionId)
const decodeInvocationMode = Schema.decodeSync(InvocationMode)
const decodeMode = (mode: InvocationModeType): InvocationModeType => decodeInvocationMode(mode)
const isDiscordGuildError = Schema.is(DiscordGuildError)

const seed = Effect.gen(function* () {
  yield* runMigrations()
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    INSERT INTO platform_connections (
      connection_id, platform, name, enabled, created_at, updated_at
    ) VALUES
      ('discord', 'discord', 'Discord', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('chat', 'slack', 'Slack', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `
  yield* sql`
    INSERT INTO discord_connections (
      connection_id, application_id, public_key, bot_token_env, respond_to_global_mentions
    ) VALUES ('discord', 'application-1', 'public-key-1', 'DISCORD_BOT_TOKEN', 1)
  `
})

test('manages guild enablement, defaults, and channel overrides', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seed
      const store = yield* DiscordGuilds
      const connectionId = decodeConnectionId('discord')
      const guildId = decodeGuildId('111111111111111111')
      const channelId = decodeChannelId('222222222222222222')

      // Enabling creates a disabled-nothing guild with safe defaults; it is idempotent.
      assert.strictEqual(yield* store.enableGuild(connectionId, guildId), 'enabled')
      assert.strictEqual(yield* store.enableGuild(connectionId, guildId), 'already-enabled')
      const listed = yield* store.listGuilds(connectionId)
      assert.deepStrictEqual(listed, [
        {
          guildId: '111111111111111111',
          enabled: true,
          invocation: { defaultMode: 'mention-only' },
          channels: [],
        },
      ])

      // Guild-wide defaults update in place.
      assert.strictEqual(
        yield* store.setGuildInvocation(connectionId, guildId, decodeMode('all-messages')),
        'updated',
      )
      assert.strictEqual(
        yield* store.setGuildUsers(connectionId, guildId, {
          mode: 'allow',
          ids: ['333333333333333333'],
        }),
        'updated',
      )
      assert.strictEqual(
        yield* store.setGuildUsers(connectionId, guildId, { mode: 'all', ids: [] }),
        'updated',
      )

      // Channel overrides merge: a later partial set preserves earlier fields.
      assert.strictEqual(
        yield* store.setChannel(connectionId, guildId, channelId, {
          users: { mode: 'deny', ids: ['444444444444444444'] },
        }),
        'updated',
      )
      assert.strictEqual(
        yield* store.setChannel(connectionId, guildId, channelId, {
          replyMode: 'reply-in-channel',
        }),
        'updated',
      )
      assert.strictEqual(yield* store.resetChannel(connectionId, guildId, channelId), 'removed')
      assert.strictEqual(yield* store.resetChannel(connectionId, guildId, channelId), 'missing')

      // A channel row needs an enabled guild to exist.
      const unknownGuild = decodeGuildId('555555555555555555')
      assert.strictEqual(
        yield* store.setChannel(connectionId, unknownGuild, channelId, {
          replyMode: 'reply-in-channel',
        }),
        'missing-guild',
      )

      // Disable and remove report idempotent outcomes and cascade overrides.
      assert.strictEqual(yield* store.disableGuild(connectionId, guildId), 'disabled')
      assert.strictEqual(yield* store.disableGuild(connectionId, guildId), 'already-disabled')
      assert.strictEqual(yield* store.enableGuild(connectionId, guildId), 'enabled')
      assert.strictEqual(
        yield* store.setChannel(connectionId, guildId, channelId, {
          replyMode: 'reply-in-channel',
        }),
        'updated',
      )
      assert.strictEqual(yield* store.removeGuild(connectionId, guildId), 'removed')
      assert.strictEqual(yield* store.removeGuild(connectionId, guildId), 'missing')
      const afterRemove = yield* store.listGuilds(connectionId)
      assert.deepStrictEqual(afterRemove, [])
      const sql = yield* SqlClient.SqlClient
      const orphanChannels = yield* sql<Record<string, unknown>>`
        SELECT * FROM discord_guild_channels WHERE connection_id = 'discord'
      `
      assert.deepStrictEqual(orphanChannels, [])

      // Missing guild updates report `missing` instead of failing.
      assert.strictEqual(
        yield* store.setGuildInvocation(connectionId, guildId, decodeMode('mention-only')),
        'missing',
      )
      assert.strictEqual(yield* store.disableGuild(connectionId, guildId), 'missing')
    }).pipe(Effect.provide(Layer.merge(guilds, database))),
  ))

test('rejects guild writes for unknown and non-Discord connections', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seed
      const store = yield* DiscordGuilds
      const guildId = decodeGuildId('111111111111111111')

      const unknown = yield* Effect.flip(store.enableGuild(decodeConnectionId('missing'), guildId))
      assert(isDiscordGuildError(unknown))
      assert.strictEqual(unknown.operation, 'unknown-connection')

      const nonDiscord = yield* Effect.flip(store.enableGuild(decodeConnectionId('chat'), guildId))
      assert(isDiscordGuildError(nonDiscord))
      assert.strictEqual(nonDiscord.operation, 'non-discord-connection')
    }).pipe(Effect.provide(Layer.merge(guilds, database))),
  ))

test('configured guilds flow into the loaded application configuration', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seed
      const store = yield* DiscordGuilds
      const connectionId = decodeConnectionId('discord')
      yield* store.enableGuild(connectionId, decodeGuildId('111111111111111111'))
      yield* store.setGuildInvocation(
        connectionId,
        decodeGuildId('111111111111111111'),
        decodeMode('all-messages'),
      )
      yield* store.setGuildUsers(connectionId, decodeGuildId('111111111111111111'), {
        mode: 'allow',
        ids: ['333333333333333333'],
      })
      yield* store.setChannel(
        connectionId,
        decodeGuildId('111111111111111111'),
        decodeChannelId('222222222222222222'),
        { replyMode: 'reply-in-channel' },
      )

      const config = yield* loadAppConfig({ environment: { DISCORD_BOT_TOKEN: 'token' } })
      const discord = config.platforms.discord[0]
      assert(discord !== undefined)
      assert.deepStrictEqual(discord.guilds, [
        {
          guildId: '111111111111111111',
          enabled: true,
          invocation: { defaultMode: 'all-messages' },
          users: { mode: 'allow', ids: ['333333333333333333'] },
          channels: [{ channelId: '222222222222222222', replyMode: 'reply-in-channel' }],
        },
      ])
    }).pipe(Effect.provide(Layer.merge(guilds, database))),
  ))
