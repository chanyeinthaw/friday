/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/strict-effect-provide, anti-slop/no-unsafe-dictionary-type -- This vitest suite exercises the real SQLite boundary (node driver); SQL rows are asserted immediately. */

import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient'
import { PlatformConnectionId } from '@friday/contracts/conversation'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { DiscordSnowflake } from './DiscordGuilds.ts'
import {
  BotTokenEnvName,
  DiscordConnectionError,
  DiscordConnections,
  DiscordConnectionsLive,
  DiscordPublicKey,
} from './DiscordConnections.ts'

const isConnectionError = Schema.is(DiscordConnectionError)

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

const SqlClientLive = SqliteClient.layer({ filename: ':memory:' })
const TestLive = DiscordConnectionsLive.pipe(Layer.provide(SqlClientLive))

describe('DiscordConnections', () => {
  it.effect('adds, reads, lists, toggles, and removes a Discord connection', () =>
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
    }).pipe(Effect.provide(Layer.mergeAll(SqlClientLive, TestLive))),
  )

  it.effect('updates connection fields, preserving unspecified ones and enforcing uniqueness', () =>
    Effect.gen(function* () {
      const store = yield* DiscordConnections
      assert.strictEqual(yield* store.addConnection(connection), 'added')

      // A no-op update reports unchanged and preserves the stored row.
      assert.strictEqual(
        yield* store.updateConnection({ connectionId: connection.connectionId, name: 'Main bot' }),
        'unchanged',
      )

      // A partial update changes only the given fields; the token stays indirected.
      assert.strictEqual(
        yield* store.updateConnection({
          connectionId: connection.connectionId,
          name: 'Renamed bot',
          botTokenEnv: decodeTokenEnv('FRIDAY_DISCORD_TOKEN_NEW'),
          respondToGlobalMentions: false,
        }),
        'updated',
      )
      const updated = yield* store.getConnection(connection.connectionId)
      assert(Option.isSome(updated))
      assert.strictEqual(updated.value.name, 'Renamed bot')
      assert.strictEqual(updated.value.botTokenEnv, 'FRIDAY_DISCORD_TOKEN_NEW')
      assert.strictEqual(updated.value.respondToGlobalMentions, false)
      assert.strictEqual(updated.value.applicationId, '111111111111111111')
      assert.strictEqual(updated.value.publicKey, '0123456789abcdef'.repeat(4))

      assert.strictEqual(
        yield* store.updateConnection({
          connectionId: connection.connectionId,
          applicationId: decodeSnowflake('999999999999999999'),
        }),
        'updated',
      )

      // Moving an application id to an existing connection is refused untouched.
      assert.strictEqual(
        yield* store.addConnection({
          ...connection,
          connectionId: decodeConnectionId('discord-other'),
          applicationId: decodeSnowflake('888888888888888888'),
        }),
        'added',
      )
      assert.strictEqual(
        yield* store.updateConnection({
          connectionId: connection.connectionId,
          applicationId: decodeSnowflake('888888888888888888'),
        }),
        'application-exists',
      )
      const untouched = yield* store.getConnection(connection.connectionId)
      assert(Option.isSome(untouched))
      assert.strictEqual(untouched.value.applicationId, '999999999999999999')

      // Reassigning an application id to no current owner is allowed.
      assert.strictEqual(
        yield* store.updateConnection({
          connectionId: connection.connectionId,
          applicationId: decodeSnowflake('111111111111111111'),
        }),
        'updated',
      )

      // Unknown connections report missing instead of failing.
      assert.strictEqual(
        yield* store.updateConnection({
          connectionId: decodeConnectionId('discord-absent'),
          name: 'Ghost',
        }),
        'missing',
      )
    }).pipe(Effect.provide(Layer.mergeAll(SqlClientLive, TestLive))),
  )

  it.effect('enforces application-id uniqueness and rolls back both-table add failures', () =>
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
    }).pipe(Effect.provide(Layer.mergeAll(SqlClientLive, TestLive))),
  )

  it.effect('remove cascades guild configuration and never removes a non-Discord connection', () =>
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
    }).pipe(Effect.provide(Layer.mergeAll(SqlClientLive, TestLive))),
  )

  it.effect('reports every single-field update as updated and persists only that field', () =>
    Effect.gen(function* () {
      const store = yield* DiscordConnections
      assert.strictEqual(yield* store.addConnection(connection), 'added')

      assert.strictEqual(
        yield* store.updateConnection({
          connectionId: connection.connectionId,
          name: 'Only renamed',
        }),
        'updated',
      )
      const renamed = yield* store.getConnection(connection.connectionId)
      assert(Option.isSome(renamed))
      assert.strictEqual(renamed.value.name, 'Only renamed')
      assert.strictEqual(renamed.value.applicationId, '111111111111111111')
      assert.strictEqual(renamed.value.publicKey, '0123456789abcdef'.repeat(4))
      assert.strictEqual(renamed.value.botTokenEnv, 'FRIDAY_DISCORD_MAIN_TOKEN')
      assert.strictEqual(renamed.value.respondToGlobalMentions, true)

      assert.strictEqual(
        yield* store.updateConnection({
          connectionId: connection.connectionId,
          publicKey: decodePublicKey('abcdef0123456789'.repeat(4)),
        }),
        'updated',
      )
      const rekeyed = yield* store.getConnection(connection.connectionId)
      assert(Option.isSome(rekeyed))
      assert.strictEqual(rekeyed.value.publicKey, 'abcdef0123456789'.repeat(4))
      assert.strictEqual(rekeyed.value.name, 'Only renamed')

      assert.strictEqual(
        yield* store.updateConnection({
          connectionId: connection.connectionId,
          applicationId: decodeSnowflake('999999999999999999'),
        }),
        'updated',
      )
      const moved = yield* store.getConnection(connection.connectionId)
      assert(Option.isSome(moved))
      assert.strictEqual(moved.value.applicationId, '999999999999999999')
      assert.strictEqual(moved.value.publicKey, 'abcdef0123456789'.repeat(4))

      assert.strictEqual(
        yield* store.updateConnection({
          connectionId: connection.connectionId,
          botTokenEnv: decodeTokenEnv('FRIDAY_DISCORD_ONLY_TOKEN'),
        }),
        'updated',
      )
      const retargeted = yield* store.getConnection(connection.connectionId)
      assert(Option.isSome(retargeted))
      assert.strictEqual(retargeted.value.botTokenEnv, 'FRIDAY_DISCORD_ONLY_TOKEN')

      assert.strictEqual(
        yield* store.updateConnection({
          connectionId: connection.connectionId,
          respondToGlobalMentions: false,
        }),
        'updated',
      )
      const quieted = yield* store.getConnection(connection.connectionId)
      assert(Option.isSome(quieted))
      assert.strictEqual(quieted.value.respondToGlobalMentions, false)
      // An update that omits the flag preserves the stored global-mention
      // behavior instead of resetting it.
      assert.strictEqual(
        yield* store.updateConnection({
          connectionId: connection.connectionId,
          name: 'Still quiet',
        }),
        'updated',
      )
      const stillQuiet = yield* store.getConnection(connection.connectionId)
      assert(Option.isSome(stillQuiet))
      assert.strictEqual(stillQuiet.value.respondToGlobalMentions, false)

      // Repeating an already-stored boolean flag reports unchanged.
      assert.strictEqual(
        yield* store.updateConnection({
          connectionId: connection.connectionId,
          respondToGlobalMentions: false,
        }),
        'unchanged',
      )
    }).pipe(Effect.provide(Layer.mergeAll(SqlClientLive, TestLive))),
  )

  it.effect('reports missing outcomes for non-Discord connections and broken rows', () =>
    Effect.gen(function* () {
      const store = yield* DiscordConnections
      const sql = yield* SqlClient.SqlClient
      yield* sql`
          INSERT INTO platform_connections
            (connection_id, platform, name, enabled, created_at, updated_at)
          VALUES ('other', 'test', 'Other', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `

      // Enable and disable never report an idempotent outcome for a
      // non-Discord connection.
      assert.strictEqual(yield* store.enableConnection(decodeConnectionId('other')), 'missing')
      assert.strictEqual(yield* store.disableConnection(decodeConnectionId('other')), 'missing')

      // A Discord platform row without its Discord topology row is treated
      // as missing instead of partially updated.
      yield* sql`
          INSERT INTO platform_connections
            (connection_id, platform, name, enabled, created_at, updated_at)
          VALUES ('broken', 'discord', 'Broken', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `
      assert.strictEqual(
        yield* store.updateConnection({
          connectionId: decodeConnectionId('broken'),
          name: 'Ghost update',
        }),
        'missing',
      )
    }).pipe(Effect.provide(Layer.mergeAll(SqlClientLive, TestLive))),
  )

  it.effect('reports stored disabled and activity-description flags through reads', () =>
    Effect.gen(function* () {
      const store = yield* DiscordConnections
      const sql = yield* SqlClient.SqlClient
      assert.strictEqual(yield* store.addConnection(connection), 'added')
      assert.strictEqual(yield* store.disableConnection(connection.connectionId), 'disabled')
      yield* sql`
          UPDATE discord_connections
          SET activity_description_public = 1
          WHERE connection_id = 'discord-main'
        `

      const listed = yield* store.listConnections()
      assert.deepStrictEqual(listed, [
        { connectionId: 'discord-main', name: 'Main bot', enabled: false },
      ])
      const detail = yield* store.getConnection(connection.connectionId)
      assert(Option.isSome(detail))
      assert.strictEqual(detail.value.enabled, false)
      assert.strictEqual(detail.value.activityDescription, true)
    }).pipe(Effect.provide(Layer.mergeAll(SqlClientLive, TestLive))),
  )

  it.effect('reports read and write failures as typed DiscordConnectionError', () =>
    Effect.gen(function* () {
      const store = yield* DiscordConnections
      const sql = yield* SqlClient.SqlClient
      assert.strictEqual(yield* store.addConnection(connection), 'added')

      // Breaking the read path surfaces typed read failures with messages.
      yield* sql`DROP TABLE platform_connections`
      const readFailure = yield* store.listConnections().pipe(Effect.flip)
      assert(isConnectionError(readFailure))
      assert.strictEqual(readFailure.operation, 'read')
      assert.strictEqual(readFailure.message, 'Discord connection read failed.')

      const detailFailure = yield* store.getConnection(connection.connectionId).pipe(Effect.flip)
      assert(isConnectionError(detailFailure))
      assert.strictEqual(detailFailure.operation, 'read')
    }).pipe(Effect.provide(Layer.mergeAll(SqlClientLive, TestLive))),
  )

  it.effect('reports failed connection writes as typed DiscordConnectionError', () =>
    Effect.gen(function* () {
      const store = yield* DiscordConnections
      const sql = yield* SqlClient.SqlClient
      yield* sql`DROP TABLE discord_connections`
      const writeFailure = yield* store
        .addConnection({
          ...connection,
          connectionId: decodeConnectionId('discord-second'),
        })
        .pipe(Effect.flip)
      assert(isConnectionError(writeFailure))
      assert.strictEqual(writeFailure.operation, 'write')
      assert.strictEqual(writeFailure.connectionId, 'discord-second')
      assert.match(writeFailure.message, /failed for discord-second/)
    }).pipe(Effect.provide(Layer.mergeAll(SqlClientLive, TestLive))),
  )
})
