/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- Fake SQL row payloads are decoded immediately by the service schema; the fake client is a test double cast to the full SqlClient interface. */

import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import {
  DiscordAdminError,
  DiscordAdmins,
  DiscordAdminsLive,
  DiscordUserId,
} from './DiscordAdmins.ts'

/** Emulates a database failure inside the fake SQL client. */
class FakeSqlFailure extends Schema.TaggedError<FakeSqlFailure>()('FakeSqlFailure', {}) {}

const isDiscordUserId = Schema.is(DiscordUserId)
const isDiscordAdminError = Schema.is(DiscordAdminError)
const decodeDiscordUserId = Schema.decodeSync(DiscordUserId)

interface AdminState {
  readonly admins: Set<string>
  /** When set, statements of this operation fail like a broken database. */
  failOperation?: 'add' | 'remove' | 'list'
}

/**
 * In-memory SqlClient that emulates only the admin allow-list statements
 * (INSERT/DELETE with RETURNING and the sorted list) and succeeds without
 * state changes for migrations. SAFETY: the fake is cast to the full client
 * interface; DiscordAdminsLive only uses the statement constructor and
 * `withTransaction`.
 */
const fakeSqlClient = (state: AdminState): SqlClient.SqlClient => {
  const fail = (operation: 'add' | 'remove' | 'list') =>
    state.failOperation === operation ? Effect.fail(new FakeSqlFailure()) : undefined
  const client = ((
    strings: TemplateStringsArray,
    ...values: ReadonlyArray<unknown>
  ): Effect.Effect<ReadonlyArray<Record<string, unknown>>, Error> => {
    const query = strings.join('?')
    if (query.includes('INSERT INTO admin_discord_users')) {
      return (
        fail('add') ??
        Effect.sync(() => {
          const userId = values[0] as string
          if (state.admins.has(userId)) return []
          state.admins.add(userId)
          return [{ user_id: userId }]
        })
      )
    }
    if (query.includes('DELETE FROM admin_discord_users')) {
      return (
        fail('remove') ??
        Effect.sync(() => {
          const userId = values[0] as string
          if (!state.admins.delete(userId)) return []
          return [{ user_id: userId }]
        })
      )
    }
    if (query.includes('SELECT user_id FROM admin_discord_users')) {
      return (
        fail('list') ?? Effect.succeed([...state.admins].sort().map((user_id) => ({ user_id })))
      )
    }
    return Effect.succeed([])
  }) as unknown as SqlClient.SqlClient
  return Object.assign(client, {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
  })
}

const adminLayer = (state: AdminState) =>
  DiscordAdminsLive.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, fakeSqlClient(state))))

describe('DiscordUserId', () => {
  it('accepts 17-20 digit snowflakes without leading zeros', () => {
    assert(isDiscordUserId('12345678901234567')) // 17 digits: minimum boundary
    assert(isDiscordUserId('123456789012345678'))
    assert(isDiscordUserId('1234567890123456789'))
    assert(isDiscordUserId('12345678901234567890')) // 20 digits: maximum boundary
  })

  it('rejects non-snowflake identifiers', () => {
    assert(!isDiscordUserId('1234567890123456')) // 16 digits: below boundary
    assert(!isDiscordUserId('123456789012345678901')) // 21 digits: above boundary
    assert(!isDiscordUserId('01234567890123456')) // leading zero
    assert(!isDiscordUserId('12345678901234567a'))
    assert(!isDiscordUserId(' 12345678901234567'))
    assert(!isDiscordUserId('12345678901234567 '))
    assert(!isDiscordUserId(''))
    assert(!isDiscordUserId('discord-user'))
  })
})

describe('DiscordAdmins', () => {
  it.effect('adds, lists, and removes administrators idempotently', () =>
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
    }).pipe(Effect.provide(adminLayer({ admins: new Set() }))),
  )

  it.effect('maps database failures to typed DiscordAdminError per operation', () => {
    const state: AdminState = { admins: new Set(), failOperation: 'add' }
    return Effect.gen(function* () {
      const userId = decodeDiscordUserId('123456789012345678')
      const admins = yield* DiscordAdmins

      const addError = yield* admins.add(userId).pipe(Effect.flip)
      assert(isDiscordAdminError(addError))
      assert.strictEqual(addError.operation, 'add')
      assert.match(addError.message, /add failed for 123456789012345678/)

      state.failOperation = 'remove'
      const removeError = yield* admins.remove(userId).pipe(Effect.flip)
      assert(isDiscordAdminError(removeError))
      assert.strictEqual(removeError.operation, 'remove')

      state.failOperation = 'list'
      const listError = yield* admins.list().pipe(Effect.flip)
      assert(isDiscordAdminError(listError))
      assert.strictEqual(listError.operation, 'list')
      assert.match(listError.message, /list failed\./)
    }).pipe(Effect.provide(adminLayer(state)))
  })
})
