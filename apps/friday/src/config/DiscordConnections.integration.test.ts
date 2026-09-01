/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, anti-slop/no-unsafe-dictionary-type -- Bun executes the SQLite integration boundary; queried rows are asserted immediately. */

import { test } from 'bun:test'
import { strict as assert } from 'node:assert'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { PlatformConnectionId } from '@friday/contracts/conversation'
import { DiscordSnowflake } from './DiscordGuilds.ts'
import {
  BotTokenEnvName,
  DiscordConnections,
  DiscordConnectionsLive,
  DiscordPublicKey,
} from './DiscordConnections.ts'

const decodeConnectionId = Schema.decodeSync(PlatformConnectionId)
const decodeSnowflake = Schema.decodeSync(DiscordSnowflake)
const decodePublicKey = Schema.decodeSync(DiscordPublicKey)
const decodeTokenEnv = Schema.decodeSync(BotTokenEnvName)

const connection = {
  connectionId: decodeConnectionId('discord-main'),
  name: 'Main bot',
  applicationId: decodeSnowflake('111111111111111111'),
  publicKey: decodePublicKey('0123456789abcdef'.repeat(4)),
  botTokenEnv: decodeTokenEnv('FRIDAY_DISCORD_MAIN_TOKEN'),
  respondToGlobalMentions: true,
}

const runWithDatabase = <A, E>(
  effect: Effect.Effect<A, E, DiscordConnections | SqlClient.SqlClient>,
) =>
  effect.pipe(
    Effect.provide(DiscordConnectionsLive),
    Effect.provide(SqliteClient.layer({ filename: ':memory:' })),
    Effect.runPromise,
  )

test('adds, reads, lists, toggles, and removes a Discord connection', async () =>
  runWithDatabase(
    Effect.gen(function* () {
      const store = yield* DiscordConnections
      assert.strictEqual(yield* store.addConnection(connection), 'added')
      assert.strictEqual(yield* store.addConnection(connection), 'connection-exists')

      const detail = yield* store.getConnection(connection.connectionId)
      assert(Option.isSome(detail))
      assert.deepStrictEqual(detail.value, {
        connectionId: 'discord-main',
        name: 'Main bot',
        enabled: true,
        applicationId: '111111111111111111',
        publicKey: '0123456789abcdef'.repeat(4),
        botTokenEnv: 'FRIDAY_DISCORD_MAIN_TOKEN',
        respondToGlobalMentions: true,
        activityDescription: false,
      })
      assert.deepStrictEqual(yield* store.listConnections(), [
        { connectionId: 'discord-main', name: 'Main bot', enabled: true },
      ])

      assert.strictEqual(yield* store.disableConnection(connection.connectionId), 'disabled')
      assert.strictEqual(
        yield* store.disableConnection(connection.connectionId),
        'already-disabled',
      )
      assert.strictEqual(yield* store.enableConnection(connection.connectionId), 'enabled')
      assert.strictEqual(yield* store.enableConnection(connection.connectionId), 'already-enabled')

      assert.strictEqual(yield* store.removeConnection(connection.connectionId), 'removed')
      assert.strictEqual(yield* store.removeConnection(connection.connectionId), 'missing')
      assert(Option.isNone(yield* store.getConnection(connection.connectionId)))
    }),
  ))

test('enforces application-id uniqueness and rolls back both-table add failures', async () =>
  runWithDatabase(
    Effect.gen(function* () {
      const store = yield* DiscordConnections
      const sql = yield* SqlClient.SqlClient
      assert.strictEqual(yield* store.addConnection(connection), 'added')

      const duplicateApplication = {
        ...connection,
        connectionId: decodeConnectionId('discord-other'),
        name: 'Other bot',
      }
      assert.strictEqual(yield* store.addConnection(duplicateApplication), 'application-exists')

      const rows = yield* sql<Record<string, unknown>>`
        SELECT connection_id FROM platform_connections ORDER BY connection_id
      `
      assert.deepStrictEqual(rows, [{ connection_id: 'discord-main' }])
    }),
  ))

test('remove cascades guild configuration and never removes a non-Discord connection', async () =>
  runWithDatabase(
    Effect.gen(function* () {
      const store = yield* DiscordConnections
      const sql = yield* SqlClient.SqlClient
      assert.strictEqual(yield* store.addConnection(connection), 'added')
      yield* sql`
        INSERT INTO discord_guilds (connection_id, guild_id, enabled, invocation_mode, users_mode)
        VALUES ('discord-main', '222222222222222222', 1, 'mention-only', NULL)
      `
      yield* sql`
        INSERT INTO platform_connections
          (connection_id, platform, name, enabled, created_at, updated_at)
        VALUES ('other', 'test', 'Other', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `

      assert.strictEqual(yield* store.removeConnection(decodeConnectionId('other')), 'missing')
      assert.strictEqual(yield* store.removeConnection(connection.connectionId), 'removed')

      const remaining = yield* sql<Record<string, unknown>>`
        SELECT connection_id, platform FROM platform_connections ORDER BY connection_id
      `
      assert.deepStrictEqual(remaining, [{ connection_id: 'other', platform: 'test' }])
      const guilds = yield* sql<Record<string, unknown>>`SELECT * FROM discord_guilds`
      assert.deepStrictEqual(guilds, [])
    }),
  ))
