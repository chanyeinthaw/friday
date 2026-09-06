/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function, effecttsgo/strict-effect-provide -- Bun runs SQLite integration tests; Effect execution is the explicit test boundary. */

import { test } from 'bun:test'
import { strict as assert } from 'node:assert'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'

import { RootUser, RootUsers, RootUsersLive } from './RootUsers.ts'

const database = SqliteClient.layer({ filename: ':memory:' })
const decodeRootUser = Schema.decodeSync(RootUser)

const rootUserA = decodeRootUser({
  platform: 'discord',
  scopeId: '111111111111111111',
  userId: '222222222222222222',
})
const rootUserB = decodeRootUser({
  platform: 'discord',
  scopeId: '333333333333333333',
  userId: '444444444444444444',
})
const rootUserW = decodeRootUser({
  platform: 'slack',
  scopeId: 'T01234567',
  userId: 'U08987654',
})

test('manages the root-user registry idempotently in SQLite', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const rootUsers = yield* RootUsers

      assert.strictEqual(yield* rootUsers.add(rootUserA), 'added')
      assert.strictEqual(yield* rootUsers.add(rootUserA), 'exists')
      assert.strictEqual(yield* rootUsers.add(rootUserB), 'added')
      assert.strictEqual(yield* rootUsers.add(rootUserW), 'added')

      assert.deepStrictEqual([...(yield* rootUsers.list())], [rootUserA, rootUserB, rootUserW])

      assert.strictEqual(yield* rootUsers.remove(rootUserA), 'removed')
      assert.strictEqual(yield* rootUsers.remove(rootUserA), 'missing')
      assert.deepStrictEqual([...(yield* rootUsers.list())], [rootUserB, rootUserW])
    }).pipe(Effect.provide(RootUsersLive.pipe(Layer.provide(database)))),
  ))

test('keys records uniquely by platform plus scope plus user', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const rootUsers = yield* RootUsers
      const sameUserOtherScope = decodeRootUser({
        platform: 'discord',
        scopeId: '999999999999999999',
        userId: '222222222222222222',
      })
      const sameScopeOtherPlatform = decodeRootUser({
        platform: 'slack',
        scopeId: '111111111111111111',
        userId: '222222222222222222',
      })

      assert.strictEqual(yield* rootUsers.add(rootUserA), 'added')
      assert.strictEqual(yield* rootUsers.add(sameUserOtherScope), 'added')
      assert.strictEqual(yield* rootUsers.add(sameScopeOtherPlatform), 'added')
      assert.deepStrictEqual(
        [...(yield* rootUsers.list())],
        [rootUserA, sameUserOtherScope, sameScopeOtherPlatform],
      )
    }).pipe(Effect.provide(RootUsersLive.pipe(Layer.provide(database)))),
  ))

test('initializes the database tables without a prior Friday start', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      // The service runs migrations during layer construction, so the CLI can
      // manage root users even before Friday has ever started.
      const rootUsers = yield* RootUsers
      assert.deepStrictEqual([...(yield* rootUsers.list())], [])
      assert.strictEqual(yield* rootUsers.add(rootUserA), 'added')
    }).pipe(Effect.provide(RootUsersLive.pipe(Layer.provide(database)))),
  ))
