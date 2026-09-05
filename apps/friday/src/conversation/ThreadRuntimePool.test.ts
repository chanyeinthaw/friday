/* oxlint-disable effecttsgo/strict-effect-provide -- Each test provides a self-contained pool layer over the TestClock service. */

import { assert, it } from '@effect/vitest'
import {
  ChannelThread,
  SteeringActivity,
  Turn,
  type Turn as TurnType,
} from '@friday/contracts/conversation'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import { TestClock } from 'effect/testing'

import type { TerminalTurn, ThreadCoordinatorContract } from './ThreadCoordinator.ts'
import { ThreadRuntimePool, ThreadRuntimePoolLive } from './ThreadRuntimePool.ts'
import { harnessReloadSucceeded, type HarnessReloadOutcome } from './ThreadRuntime.ts'
import { ThreadRuntimeError } from './ThreadRuntimes.ts'

const thread = Schema.decodeSync(ChannelThread)({
  id: 'thread-runtime-pool',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/friday/thread-runtime-pool',
  model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
  thinkingLevel: 'max',
  channelContext: { name: 'Friday test channel', description: '' },
  conversationBinding: {
    platform: 'discord',
    connectionId: 'discord',
    channelId: 'channel-runtime-pool',
    sourceMessageId: 'message-runtime-pool',
    conversationId: 'platform-conversation-runtime-pool',
  },
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})
const steeringActivity = Schema.decodeSync(SteeringActivity)({
  id: 'activity-steering',
  sequence: 0,
  status: 'completed',
  type: 'steering',
  message: { source: 'user', content: { text: 'Also inspect the tests', images: [] } },
  createdAt: '2026-03-21T10:00:01.000Z',
  updatedAt: '2026-03-21T10:00:01.000Z',
  completedAt: '2026-03-21T10:00:01.000Z',
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

it.effect('opens one runtime for concurrent same-thread acquisitions', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const openStarted = yield* Deferred.make<void>()
      const releaseOpen = yield* Deferred.make<void>()
      let opened = 0
      const pool = yield* ThreadRuntimePool.pipe(
        Effect.provide(
          testLayer(() =>
            Deferred.succeed(openStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseOpen)),
              Effect.andThen(Effect.sync(() => makeCoordinator(++opened))),
            ),
          ),
        ),
      )

      const first = yield* pool.acquire(thread).pipe(Effect.forkChild)
      yield* Deferred.await(openStarted)
      const second = yield* pool.acquire(thread).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      assert.strictEqual(opened, 0)

      yield* Deferred.succeed(releaseOpen, undefined)
      const coordinators = yield* Effect.all([Fiber.join(first), Fiber.join(second)])

      assert.strictEqual(coordinators[0], coordinators[1])
      assert.strictEqual(opened, 1)
    }),
  ).pipe(Effect.provide(TestClock.layer())),
)

it.effect('closes a failed open scope and permits a retry', () =>
  Effect.scoped(
    Effect.gen(function* () {
      let attempts = 0
      let released = 0
      const pool = yield* ThreadRuntimePool.pipe(
        Effect.provide(
          testLayer(() =>
            Effect.gen(function* () {
              attempts += 1
              yield* Scope.addFinalizer(
                yield* Effect.scope,
                Effect.sync(() => {
                  released += 1
                }),
              )
              if (attempts === 1)
                return yield* new ThreadRuntimeError({ operation: 'open', cause: 'open-failed' })
              return makeCoordinator(attempts)
            }),
          ),
        ),
      )

      const failed = yield* pool.acquire(thread).pipe(Effect.exit)
      const coordinator = yield* pool.acquire(thread)
      const reused = yield* pool.acquire(thread)

      assert(Exit.isFailure(failed))
      assert.strictEqual(coordinator, reused)
      assert.strictEqual(attempts, 2)
      assert.strictEqual(released, 1)
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

it.effect('releases prompt accounting when prompting fails immediately', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pool = yield* ThreadRuntimePool.pipe(
        Effect.provide(
          testLayer(() =>
            Effect.succeed({
              ...makeCoordinator(1),
              prompt: () =>
                Effect.fail(
                  new ThreadRuntimeError({ operation: 'prompt', cause: 'prompt-failed' }),
                ),
            }),
          ),
        ),
      )
      const coordinator = yield* pool.acquire(thread)

      const failed = yield* coordinator.prompt(turn).pipe(Effect.exit)
      const outcome = yield* pool.reloadHarness(thread.id)

      assert(Exit.isFailure(failed))
      assert.deepStrictEqual(outcome, { ok: true })
    }),
  ).pipe(Effect.provide(TestClock.layer())),
)

it.effect('releases prompt accounting when terminal observation fails', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const reloadInvoked = yield* Deferred.make<void>()
      let reloads = 0
      const pool = yield* ThreadRuntimePool.pipe(
        Effect.provide(
          testLayer(() =>
            Effect.succeed(
              makeCoordinator(
                1,
                Effect.fail(
                  new ThreadRuntimeError({ operation: 'events', cause: 'terminal-failed' }),
                ),
                Effect.gen(function* () {
                  reloads += 1
                  yield* Deferred.succeed(reloadInvoked, undefined)
                  return harnessReloadSucceeded()
                }),
              ),
            ),
          ),
        ),
      )
      const coordinator = yield* pool.acquire(thread)
      const handle = yield* coordinator.prompt(turn)
      const terminal = yield* handle.awaitTerminal.pipe(Effect.exit)
      assert(Exit.isFailure(terminal))

      // The pool can invoke the underlying reload only after observeTerminal has
      // decremented activeTurns. Wait for that existing observable boundary rather
      // than relying on a scheduler yield.
      const reloadFiber = yield* pool.reloadHarness(thread.id).pipe(Effect.forkChild)
      yield* Deferred.await(reloadInvoked)
      const outcome = yield* Fiber.join(reloadFiber)

      assert.deepStrictEqual(outcome, { ok: true })
      assert.strictEqual(reloads, 1)
    }),
  ).pipe(Effect.provide(TestClock.layer())),
)

it.effect('refreshes activity when steering a runtime', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pool = yield* ThreadRuntimePool.pipe(
        Effect.provide(testLayer(() => Effect.succeed(makeCoordinator(1)))),
      )
      const coordinator = yield* pool.acquire(thread)
      yield* TestClock.adjust('29 minutes')
      yield* coordinator.steer(turn.id, steeringActivity)
      yield* TestClock.adjust('2 minutes')
      yield* pool.reapIdle

      assert.strictEqual(yield* pool.acquire(thread), coordinator)
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

it.effect('refuses harness reload for a thread with no open runtime', () =>
  Effect.scoped(
    Effect.gen(function* () {
      let opened = 0
      const pool = yield* ThreadRuntimePool.pipe(
        Effect.provide(testLayer(() => Effect.succeed(makeCoordinator(++opened)))),
      )

      const outcome = yield* pool.reloadHarness(thread.id)

      assert.deepStrictEqual(outcome, {
        ok: false,
        reason: 'no-runtime',
        detail:
          'No live harness runtime is open for this thread; send a message to start one before reloading.',
      })
      // A reload never opens an absent runtime as a side effect.
      assert.strictEqual(opened, 0)
    }),
  ).pipe(Effect.provide(TestClock.layer())),
)

it.effect('reloads the harness through the open runtime when idle', () =>
  Effect.scoped(
    Effect.gen(function* () {
      let reloads = 0
      const pool = yield* ThreadRuntimePool.pipe(
        Effect.provide(
          testLayer(() =>
            Effect.succeed(
              makeCoordinator(
                1,
                Effect.succeed(completedTurn(turn)),
                Effect.sync(() => {
                  reloads += 1
                  return harnessReloadSucceeded()
                }),
              ),
            ),
          ),
        ),
      )
      yield* pool.acquire(thread)

      const outcome = yield* pool.reloadHarness(thread.id)

      assert.deepStrictEqual(outcome, { ok: true })
      assert.strictEqual(reloads, 1)
    }),
  ).pipe(Effect.provide(TestClock.layer())),
)

it.effect('refuses harness reload while a Turn is active', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const terminal = yield* Deferred.make<TerminalTurn>()
      let reloads = 0
      const pool = yield* ThreadRuntimePool.pipe(
        Effect.provide(
          testLayer(() =>
            Effect.succeed(
              makeCoordinator(
                1,
                Deferred.await(terminal),
                Effect.sync(() => {
                  reloads += 1
                  return harnessReloadSucceeded()
                }),
              ),
            ),
          ),
        ),
      )
      const coordinator = yield* pool.acquire(thread)
      const handle = yield* coordinator.prompt(turn)

      const outcome = yield* pool.reloadHarness(thread.id)

      assert.deepStrictEqual(outcome, {
        ok: false,
        reason: 'busy',
        detail: 'A turn is active in this thread; wait for it to finish before reloading.',
      })
      assert.strictEqual(reloads, 0)

      yield* Deferred.succeed(terminal, completedTurn(turn))
      yield* handle.awaitTerminal
    }),
  ).pipe(Effect.provide(TestClock.layer())),
)

const testLayer = (
  open: () => Effect.Effect<
    ThreadCoordinatorContract<ThreadRuntimeError, ThreadRuntimeError>,
    ThreadRuntimeError,
    Scope.Scope
  >,
) =>
  ThreadRuntimePoolLive(() => open(), {
    idleTimeout: '30 minutes',
    reaperInterval: '1 hour',
  })

const makeCoordinator = (
  identity: number,
  awaitTerminal: Effect.Effect<TerminalTurn, ThreadRuntimeError> = Effect.succeed(
    completedTurn(turn),
  ),
  reload: Effect.Effect<HarnessReloadOutcome> = Effect.succeed(harnessReloadSucceeded()),
): ThreadCoordinatorContract<ThreadRuntimeError, ThreadRuntimeError> => ({
  prompt: (promptedTurn: TurnType) =>
    Effect.succeed({
      turnId: promptedTurn.id,
      awaitTerminal,
    }),
  steer: () => Effect.void,
  cancel: () => Effect.void,
  reload: () => reload,
  onEvent: () => Effect.void,
  start: Effect.void,
  drain: Effect.sync(() => identity).pipe(Effect.asVoid),
})

const completedTurn = (completed: TurnType): TerminalTurn => ({
  status: 'completed',
  turnId: completed.id,
  agentMessage: 'Done.',
  usage: null,
})
