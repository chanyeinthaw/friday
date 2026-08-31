/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests -- Bun executes the SQLite integration boundary. */

import { test } from 'bun:test'
import { strict as assert } from 'node:assert'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { PlatformConnectionId } from '@friday/contracts/conversation'

import { runMigrations } from '../persistence/Migrations.ts'
import { SystemChannels, SystemChannelsLive } from './SystemChannels.ts'

const database = SqliteClient.layer({ filename: ':memory:' })
const channels = SystemChannelsLive.pipe(Layer.provide(database))
const connectionId = Schema.decodeSync(PlatformConnectionId)('discord')

test('configures and removes a system channel', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* runMigrations()
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        INSERT INTO platform_connections (
          connection_id, platform, name, enabled, created_at, updated_at
        ) VALUES ('discord', 'discord', 'Discord', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `
      const systemChannels = yield* SystemChannels
      yield* systemChannels.set(connectionId, 'channel-1')
      const configured = yield* sql<{ readonly channel_id: string }>`
        SELECT channel_id FROM platform_system_channels
      `
      assert.deepStrictEqual(configured, [{ channel_id: 'channel-1' }])
      yield* systemChannels.reset(connectionId, 'channel-1')
      const removed = yield* sql<{ readonly channel_id: string }>`
        SELECT channel_id FROM platform_system_channels
      `
      assert.deepStrictEqual(removed, [])
    }).pipe(Effect.provide(Layer.merge(channels, database))),
  ))
