/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests -- Bun executes the SQLite integration boundary; queried rows are asserted immediately. */

import { test } from 'bun:test'
import { strict as assert } from 'node:assert'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { PlatformConnectionId } from '@friday/contracts/conversation'
import {
  SlackChannelId,
  SlackConnections,
  SlackConnectionsLive,
  SlackTokenEnvName,
} from './SlackConnections.ts'

const decodeConnectionId = Schema.decodeSync(PlatformConnectionId)
const decodeChannelId = Schema.decodeSync(SlackChannelId)
const decodeTokenEnv = Schema.decodeSync(SlackTokenEnvName)

const connection = {
  connectionId: decodeConnectionId('slack-personal'),
  name: 'Personal Slack',
  botTokenEnv: decodeTokenEnv('FRIDAY_SLACK_BOT_TOKEN'),
  appTokenEnv: decodeTokenEnv('FRIDAY_SLACK_APP_TOKEN'),
}

const runWithDatabase = <A, E>(
  effect: Effect.Effect<A, E, SlackConnections | SqlClient.SqlClient>,
) =>
  effect.pipe(
    Effect.provide(SlackConnectionsLive),
    Effect.provide(SqliteClient.layer({ filename: ':memory:' })),
    Effect.runPromise,
  )

test('upserts, reads, and resets Slack channel invocation and reply overrides', async () =>
  runWithDatabase(
    Effect.gen(function* () {
      const store = yield* SlackConnections
      assert.strictEqual(yield* store.addConnection(connection), 'added')
      const channelId = decodeChannelId('C456')

      // An invocation-only patch stores no reply override; the connection
      // default keeps applying until explicitly overridden.
      assert.strictEqual(
        yield* store.setChannel(connection.connectionId, channelId, {
          invocationMode: 'all-messages',
        }),
        'updated',
      )
      const invoked = yield* store.getConnection(connection.connectionId)
      assert(Option.isSome(invoked))
      assert.deepStrictEqual(invoked.value.channelOverrides, [
        { channelId: 'C456', invocationMode: 'all-messages' },
      ])

      // A repeat of the same patch reports unchanged.
      assert.strictEqual(
        yield* store.setChannel(connection.connectionId, channelId, {
          invocationMode: 'all-messages',
        }),
        'unchanged',
      )

      // A reply patch on the same channel merges instead of replacing.
      assert.strictEqual(
        yield* store.setChannel(connection.connectionId, channelId, {
          replyMode: 'reply-in-channel',
        }),
        'updated',
      )
      const merged = yield* store.getConnection(connection.connectionId)
      assert(Option.isSome(merged))
      assert.deepStrictEqual(merged.value.channelOverrides, [
        { channelId: 'C456', invocationMode: 'all-messages', replyMode: 'reply-in-channel' },
      ])

      assert.strictEqual(yield* store.resetChannel(connection.connectionId, channelId), 'removed')
      assert.strictEqual(yield* store.resetChannel(connection.connectionId, channelId), 'missing')
      const reset = yield* store.getConnection(connection.connectionId)
      assert(Option.isSome(reset))
      assert.deepStrictEqual(reset.value.channelOverrides, [])

      // Channel writes to an unknown connection stay missing.
      assert.strictEqual(
        yield* store.setChannel(decodeConnectionId('slack-unknown'), channelId, {
          invocationMode: 'all-messages',
        }),
        'missing-connection',
      )
    }),
  ))
