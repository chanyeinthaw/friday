import {
  ChannelThread,
  PlatformConnectionId,
  PlatformConversationId,
} from '@friday/contracts/conversation'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { reloadConversationHarness } from './HarnessReload.ts'
import { PersistenceSqlError } from '../persistence/Errors.ts'
import {
  harnessReloadFailed,
  harnessReloadRefused,
  harnessReloadSucceeded,
  type HarnessReloadOutcome,
} from './ThreadRuntime.ts'

const lookup = {
  platform: 'discord' as const,
  connectionId: Schema.decodeSync(PlatformConnectionId)('discord'),
  conversationId: Schema.decodeSync(PlatformConversationId)('platform-conversation-harness-reload'),
}

const thread = Schema.decodeSync(ChannelThread)({
  id: 'thread-harness-reload',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/friday/thread-harness-reload',
  model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
  thinkingLevel: 'max',
  channelContext: { name: 'Friday test channel', description: '' },
  conversationBinding: {
    platform: 'discord',
    connectionId: 'discord',
    channelId: 'channel-harness-reload',
    sourceMessageId: 'message-harness-reload',
    conversationId: 'platform-conversation-harness-reload',
  },
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})

describe('reloadConversationHarness', () => {
  it.effect('refuses with unknown-thread when no thread is bound to the conversation', () =>
    Effect.gen(function* () {
      let reloaded = 0
      const outcome = yield* reloadConversationHarness({
        findThread: () => Effect.succeed(Option.none()),
        reloadRuntime: () =>
          Effect.sync(() => {
            reloaded += 1
            return harnessReloadSucceeded()
          }),
      })(lookup)

      assert.deepStrictEqual(outcome, {
        ok: false,
        reason: 'unknown-thread',
        detail:
          'No Friday thread is bound to this conversation; run the command inside a Friday thread.',
      })
      assert.strictEqual(reloaded, 0)
    }),
  )

  it.effect('reloads the runtime of the thread bound to the conversation', () =>
    Effect.gen(function* () {
      const reloadedThreadIds: Array<string> = []
      const outcome = yield* reloadConversationHarness({
        findThread: () => Effect.succeed(Option.some(thread)),
        reloadRuntime: (threadId) =>
          Effect.sync(() => {
            reloadedThreadIds.push(threadId)
            return harnessReloadSucceeded()
          }),
      })(lookup)

      assert.deepStrictEqual(outcome, { ok: true })
      assert.deepStrictEqual(reloadedThreadIds, ['thread-harness-reload'])
    }),
  )

  it.effect('propagates the pool refusal outcomes unchanged', () =>
    Effect.gen(function* () {
      const busy: HarnessReloadOutcome = harnessReloadRefused(
        'busy',
        'A turn is active in this thread; wait for it to finish before reloading.',
      )
      const outcome = yield* reloadConversationHarness({
        findThread: () => Effect.succeed(Option.some(thread)),
        reloadRuntime: () => Effect.succeed(busy),
      })(lookup)

      assert.deepStrictEqual(outcome, busy)
    }),
  )

  it.effect('maps persistence failures into a structured reload-failed outcome', () =>
    Effect.gen(function* () {
      const outcome = yield* reloadConversationHarness({
        findThread: () =>
          Effect.fail(
            new PersistenceSqlError({ operation: 'find-platform-thread', detail: 'locked' }),
          ),
        reloadRuntime: () => Effect.succeed(harnessReloadSucceeded()),
      })(lookup)

      assert.deepStrictEqual(
        outcome,
        harnessReloadFailed('SQL error in find-platform-thread: locked'),
      )
    }),
  )
})
