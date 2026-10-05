/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/strict-effect-provide -- Bun is the SQLite integration test boundary. */
import { test, expect } from 'bun:test'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { runStructuralMigrations } from '../persistence/Migrations.ts'
import { OptChatConfiguration, OptChatConfigurationLive } from './OptChatConfiguration.ts'

const binding = {
  id: 'chan',
  platform: 'discord' as const,
  connectionId: 'discord',
  channelId: '123',
  ownerUserId: '456',
}
const configured = Effect.gen(function* () {
  yield* runStructuralMigrations()
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO platform_connections (connection_id, platform, name, enabled, created_at, updated_at) VALUES ('discord', 'discord', 'Discord', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  return sql
})
test('OptChat bindings retain identity through disabling and refuse owner transfers', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* configured
      const config = yield* OptChatConfiguration
      yield* config.add(binding)
      yield* config.disable('chan')
      expect(yield* config.list()).toEqual([{ ...binding, enabled: 0 }])
      expect(
        (yield* Effect.exit(config.add({ ...binding, ownerUserId: 'someone-else' })))._tag,
      ).toBe('Failure')
      expect((yield* Effect.exit(config.add({ ...binding, id: 'another-memory' })))._tag).toBe(
        'Failure',
      )
      yield* config.add(binding)
      expect(yield* config.list()).toEqual([{ ...binding, enabled: 1 }])
      expect(
        (yield* Effect.exit(
          config.add({ ...binding, id: 'missing', connectionId: 'missing', channelId: 'other' }),
        ))._tag,
      ).toBe('Failure')
    }).pipe(
      Effect.provide(OptChatConfigurationLive),
      Effect.provide(SqliteClient.layer({ filename: ':memory:' })),
    ),
  ))
