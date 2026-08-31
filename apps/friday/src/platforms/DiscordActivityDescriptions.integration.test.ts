/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests -- Bun executes the SQLite integration boundary. */

import { test } from 'bun:test'
import { PlatformConnectionId } from '@friday/contracts/conversation'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import { strict as assert } from 'node:assert'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runMigrations } from '../persistence/Migrations.ts'
import {
  DiscordActivityDescriptions,
  DiscordActivityDescriptionsLive,
  NonDiscordPlatformConnectionError,
  UnknownPlatformConnectionError,
} from './DiscordActivityDescriptions.ts'

const connectionId = Schema.decodeSync(PlatformConnectionId)('discord-personal')
const unknownConnectionId = Schema.decodeSync(PlatformConnectionId)('missing')
const slackConnectionId = Schema.decodeSync(PlatformConnectionId)('slack-personal')
const isUnknownPlatformConnectionError = Schema.is(UnknownPlatformConnectionError)
const isNonDiscordPlatformConnectionError = Schema.is(NonDiscordPlatformConnectionError)

const withDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const database = SqliteClient.layer({ filename: ':memory:' })
  const descriptions = DiscordActivityDescriptionsLive.pipe(Layer.provide(database))
  return effect.pipe(Effect.provide(Layer.merge(descriptions, database)))
}

const insertDiscordConnection = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    INSERT INTO platform_connections (
      connection_id, platform, name, enabled, created_at, updated_at
    ) VALUES (
      'discord-personal', 'discord', 'Discord', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `
  yield* sql`
    INSERT INTO discord_connections (
      connection_id, application_id, public_key, bot_token_env, respond_to_global_mentions
    ) VALUES (
      'discord-personal', 'application-id', 'public-key', 'DISCORD_TOKEN', 0
    )
  `
})

test('set works against a fresh database by running migrations first', async () =>
  Effect.runPromise(
    withDatabase(
      Effect.gen(function* () {
        const descriptions = yield* DiscordActivityDescriptions
        yield* insertDiscordConnection
        yield* descriptions.set(connectionId)
        assert.strictEqual(yield* descriptions.enabled(connectionId), true)
      }),
    ),
  ))

test('set upgrades a pre-activity-description database before updating', async () =>
  Effect.runPromise(
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`DROP TABLE discord_connections`
        yield* sql`
          CREATE TABLE discord_connections (
            connection_id TEXT PRIMARY KEY,
            application_id TEXT NOT NULL,
            public_key TEXT NOT NULL,
            bot_token_env TEXT NOT NULL,
            respond_to_global_mentions INTEGER NOT NULL CHECK (respond_to_global_mentions IN (0, 1)),
            FOREIGN KEY (connection_id) REFERENCES platform_connections(connection_id) ON DELETE CASCADE
          )
        `
        yield* sql`
          INSERT INTO platform_connections (
            connection_id, platform, name, enabled, created_at, updated_at
          ) VALUES (
            'discord-personal', 'discord', 'Discord', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
        `
        yield* sql`
          INSERT INTO discord_connections (
            connection_id, application_id, public_key, bot_token_env, respond_to_global_mentions
          ) VALUES (
            'discord-personal', 'application-id', 'public-key', 'DISCORD_TOKEN', 0
          )
        `
        yield* runMigrations()
        const descriptions = yield* DiscordActivityDescriptions
        yield* descriptions.set(connectionId)
        assert.strictEqual(yield* descriptions.enabled(connectionId), true)
      }),
    ),
  ))

test('set returns a typed unknown-connection error', async () =>
  Effect.runPromise(
    withDatabase(
      Effect.gen(function* () {
        const descriptions = yield* DiscordActivityDescriptions
        const error = yield* descriptions.set(unknownConnectionId).pipe(Effect.flip)
        assert(isUnknownPlatformConnectionError(error))
        assert.strictEqual(error.connectionId, unknownConnectionId)
      }),
    ),
  ))

test('set returns a typed non-Discord connection error', async () =>
  Effect.runPromise(
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          INSERT INTO platform_connections (
            connection_id, platform, name, enabled, created_at, updated_at
          ) VALUES (
            'slack-personal', 'slack', 'Slack', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
        `
        const descriptions = yield* DiscordActivityDescriptions
        const error = yield* descriptions.set(slackConnectionId).pipe(Effect.flip)
        assert(isNonDiscordPlatformConnectionError(error))
        assert.strictEqual(error.connectionId, slackConnectionId)
        assert.strictEqual(error.platform, 'slack')
      }),
    ),
  ))
