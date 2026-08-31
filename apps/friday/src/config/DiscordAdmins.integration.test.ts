/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function, effecttsgo/strict-effect-provide -- Bun runs SQLite integration tests; Effect execution is the explicit test boundary. */

import { test } from 'bun:test'
import { strict as assert } from 'node:assert'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'

import { DiscordAdmins, DiscordAdminsLive, DiscordUserId } from './DiscordAdmins.ts'

const database = SqliteClient.layer({ filename: ':memory:' })
const decodeDiscordUserId = Schema.decodeSync(DiscordUserId)

test('manages the admin allow-list idempotently in SQLite', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const admins = yield* DiscordAdmins
      const first = decodeDiscordUserId('123456789012345678')
      const second = decodeDiscordUserId('234567890123456789')

      assert.strictEqual(yield* admins.add(first), 'added')
      assert.strictEqual(yield* admins.add(first), 'exists')
      assert.strictEqual(yield* admins.add(second), 'added')

      assert.deepStrictEqual(
        [...(yield* admins.list())],
        ['123456789012345678', '234567890123456789'],
      )

      assert.strictEqual(yield* admins.remove(first), 'removed')
      assert.strictEqual(yield* admins.remove(first), 'missing')
      assert.deepStrictEqual([...(yield* admins.list())], ['234567890123456789'])
    }).pipe(Effect.provide(DiscordAdminsLive.pipe(Layer.provide(database)))),
  ))

test('initializes the database tables without a prior Friday start', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      // The service runs migrations during layer construction, so the CLI can
      // manage administrators even before Friday has ever started.
      const admins = yield* DiscordAdmins
      assert.deepStrictEqual([...(yield* admins.list())], [])
      assert.strictEqual(yield* admins.add(decodeDiscordUserId('123456789012345678')), 'added')
    }).pipe(Effect.provide(DiscordAdminsLive.pipe(Layer.provide(database)))),
  ))
