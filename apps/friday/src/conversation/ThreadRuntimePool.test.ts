/* oxlint-disable effecttsgo/strict-effect-provide -- Each test provides a self-contained pool layer over the TestClock service. */

import { assert, it } from '@effect/vitest'
import { ChannelThread, Turn, type Turn as TurnType } from '@friday/contracts/conversation'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import { TestClock } from 'effect/testing'

import type { TerminalTurn, ThreadCoordinatorContract } from './ThreadCoordinator.ts'
import { ThreadRuntimePool, ThreadRuntimePoolLive } from './ThreadRuntimePool.ts'
import type { ThreadRuntimeError } from './ThreadRuntimes.ts'

const thread = Schema.decodeSync(ChannelThread)({
  id: 'thread-runtime-pool',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/friday/thread-runtime-pool',
  model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
  thinkingLevel: 'max',
  externalBinding: {
    platform: 'discord',
    channelId: 'channel-runtime-pool',
    sourceMessageId: 'message-runtime-pool',
    externalThreadId: 'external-thread-runtime-pool',
  },
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})
const turn = Schema.decodeSync(Turn)({
  id: 'turn-runtime-pool',
  threadId: thread.id,
  sequence: 1,
  input: { source: 'user', content: { text: 'Work', images: [] } },
  agentMessage: null,
  activities: [],
  model: thread.model,
  thinkingLevel: thread.thinkingLevel,
  harnessTurnId: null,
  status: 'pending',
  requestedAt: '2026-03-21T10:00:00.000Z',
  startedAt: null,
  completedAt: null,
  errorMessage: null,
  usage: null,
})

it.effect('reuses one runtime entry for the same Thread', () =>
  Effect.scoped(
    Effect.gen(function* () {
      let opened = 0
      const pool = yield* ThreadRuntimePool.pipe(
        Effect.provide(testLayer(() => Effect.succeed(makeCoordinator(++opened)))),
      )

      const first = yield* pool.acquire(thread)
      const second = yield* pool.acquire(thread)

      assert.strictEqual(first, second)
      assert.strictEqual(opened, 1)
    }),
  ).pipe(Effect.provide(TestClock.layer())),
)

it.effect('reaps an idle runtime after thirty minutes and recreates it', () =>
  Effect.scoped(
    Effect.gen(function* () {
      let opened = 0
      let released = 0
      const pool = yield* ThreadRuntimePool.pipe(
        Effect.provide(
          testLayer(() =>
            Effect.gen(function* () {
              opened += 1
              yield* Scope.addFinalizer(
                yield* Effect.scope,
                Effect.sync(() => {
                  released += 1
                }),
              )
              return makeCoordinator(opened)
            }),
          ),
        ),
      )

      const first = yield* pool.acquire(thread)
      yield* TestClock.adjust('30 minutes')
      yield* pool.reapIdle
      const second = yield* pool.acquire(thread)

      assert.notStrictEqual(first, second)
      assert.strictEqual(opened, 2)
      assert.strictEqual(released, 1)
    }),
  ).pipe(Effect.provide(TestClock.layer())),
)

it.effect('does not reap a runtime while its Turn is active', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const terminal = yield* Deferred.make<TerminalTurn>()
      let opened = 0
      let released = 0
      const pool = yield* ThreadRuntimePool.pipe(
        Effect.provide(
          testLayer(() =>
            Effect.gen(function* () {
              opened += 1
              yield* Scope.addFinalizer(
                yield* Effect.scope,
                Effect.sync(() => {
                  released += 1
                }),
              )
              return makeCoordinator(opened, Deferred.await(terminal))
            }),
          ),
        ),
      )

      const coordinator = yield* pool.acquire(thread)
      const handle = yield* coordinator.prompt(turn)
      yield* TestClock.adjust('60 minutes')
      yield* pool.reapIdle
      assert.strictEqual(yield* pool.acquire(thread), coordinator)
      assert.strictEqual(released, 0)

      yield* Deferred.succeed(terminal, completedTurn(turn))
      yield* handle.awaitTerminal
      yield* TestClock.adjust('30 minutes')
      yield* pool.reapIdle

      assert.strictEqual(released, 1)
      assert.strictEqual(opened, 1)
    }),
  ).pipe(Effect.provide(TestClock.layer())),
)

const testLayer = (
  open: () => Effect.Effect<
    ThreadCoordinatorContract<ThreadRuntimeError, ThreadRuntimeError>,
    never,
    Scope.Scope
  >,
) =>
  ThreadRuntimePoolLive(() => open(), {
    idleTimeout: '30 minutes',
    reaperInterval: '1 hour',
  })

const makeCoordinator = (
  identity: number,
  awaitTerminal: Effect.Effect<TerminalTurn> = Effect.succeed(completedTurn(turn)),
): ThreadCoordinatorContract<ThreadRuntimeError, ThreadRuntimeError> => ({
  prompt: (promptedTurn: TurnType) =>
    Effect.succeed({
      turnId: promptedTurn.id,
      awaitTerminal,
    }),
  steer: () => Effect.void,
  start: Effect.void,
  drain: Effect.sync(() => identity).pipe(Effect.asVoid),
})

const completedTurn = (completed: TurnType): TerminalTurn => ({
  status: 'completed',
  turnId: completed.id,
  agentMessage: 'Done.',
  usage: null,
})
