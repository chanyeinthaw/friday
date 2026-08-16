/* oxlint-disable effecttsgo/strict-effect-provide -- Unit tests provide the TestClock test service per test because @effect/vitest does not provision it; each provide wraps a self-contained scoped program. */

import { assert, it } from '@effect/vitest'
import {
  SurfaceBinding,
  type SurfaceBinding as SurfaceBindingType,
} from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Logger from 'effect/Logger'
import * as Schema from 'effect/Schema'
import { TestClock } from 'effect/testing'

import { makeChatSdkSurface, type ChatSdkPublicationSource } from './ChatSdkSurface.ts'

const binding: SurfaceBindingType = Schema.decodeSync(SurfaceBinding)({
  surface: 'discord',
  channelId: 'discord:channel-1',
  sourceMessageId: 'message-1',
  conversationId: 'discord:channel-1:message-1',
})

const makeTypingSource = (calls: Array<string>): ChatSdkPublicationSource => ({
  thread: (threadId) => ({
    post: () => Promise.resolve({}),
    startTyping: () => {
      calls.push(threadId)
      return Promise.resolve()
    },
  }),
})

// Lets `count` typing refresh intervals elapse on the test clock. Each
// interval crosses a real promise microtask: advancing the clock wakes the
// refresh fiber at its sleep deadline, but its next sleep is only registered
// after the microtask flush, so every elapsed interval is followed by a
// `yieldNow` before the next interval.
const elapseRefreshIntervals = (count: number): Effect.Effect<void> =>
  Effect.forEach(Array.from({ length: count }), () =>
    TestClock.adjust('1 second').pipe(Effect.andThen(Effect.yieldNow)),
  ).pipe(Effect.asVoid)

const typedThreadId = 'discord:channel-1:message-1'

it.effect('uses the configured Surface kind', () =>
  Effect.gen(function* () {
    const surface = yield* makeChatSdkSurface('slack', makeTypingSource([]))
    assert.strictEqual(surface.kind, 'slack')
  }),
)

it.effect('publishes final text through the bound Chat SDK thread', () =>
  Effect.gen(function* () {
    const publications: Array<string> = []
    const platform = yield* makeChatSdkSurface('discord', {
      thread: (threadId) => ({
        post: (text) => {
          publications.push(`${threadId}:${text}`)
          return Promise.resolve({})
        },
        startTyping: () => Promise.resolve(),
      }),
    })

    yield* platform.publish({ binding, text: 'Friday is done.' })

    assert.deepStrictEqual(publications, [`${typedThreadId}:Friday is done.`])
  }),
)

it.effect('sends typing immediately, refreshes while running, and stops after success', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: Array<string> = []
      const platform = yield* makeChatSdkSurface('discord', makeTypingSource(calls), {
        typingRefreshInterval: '1 second',
      })

      // The wrapped effect completes at t=3.5s; ticks fire at t=1s, 2s, 3s and
      // the tick due at t=4s is interrupted by scope closure.
      const fiber = yield* platform
        .withTyping(binding, Effect.sleep('3.5 seconds'))
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* elapseRefreshIntervals(3)
      yield* TestClock.adjust('0.5 seconds')

      const exit = yield* Fiber.await(fiber)
      assert(Exit.isSuccess(exit))
      assert.deepStrictEqual(calls, [typedThreadId, typedThreadId, typedThreadId, typedThreadId])

      yield* elapseRefreshIntervals(5)
      assert.strictEqual(calls.length, 4)
    }),
  ).pipe(Effect.provide(TestClock.layer())),
)

it.effect('stops refreshing after the wrapped effect fails', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: Array<string> = []
      const platform = yield* makeChatSdkSurface('discord', makeTypingSource(calls), {
        typingRefreshInterval: '1 second',
      })

      const fiber = yield* platform
        .withTyping(binding, Effect.sleep('3.5 seconds').pipe(Effect.andThen(Effect.fail('boom'))))
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* elapseRefreshIntervals(3)
      yield* TestClock.adjust('0.5 seconds')

      const exit = yield* Fiber.await(fiber)
      assert(Exit.isFailure(exit))
      assert.deepStrictEqual(calls, [typedThreadId, typedThreadId, typedThreadId, typedThreadId])

      yield* elapseRefreshIntervals(5)
      assert.strictEqual(calls.length, 4)
    }),
  ).pipe(Effect.provide(TestClock.layer())),
)

it.effect('stops all typing refreshes when the wrapped effect dies', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: Array<string> = []
      const platform = yield* makeChatSdkSurface('discord', makeTypingSource(calls), {
        typingRefreshInterval: '1 second',
      })

      const fiber = yield* platform
        .withTyping(binding, Effect.sleep('3.5 seconds').pipe(Effect.andThen(Effect.die('boom'))))
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* elapseRefreshIntervals(3)
      yield* TestClock.adjust('0.5 seconds')

      const exit = yield* Fiber.await(fiber)
      assert(Exit.isFailure(exit))
      assert(Exit.hasDies(exit))
      assert.deepStrictEqual(calls, [typedThreadId, typedThreadId, typedThreadId, typedThreadId])

      yield* elapseRefreshIntervals(5)
      assert.strictEqual(calls.length, 4)
    }),
  ).pipe(Effect.provide(TestClock.layer())),
)

it.effect('stops refreshing when the wrapped effect is interrupted', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: Array<string> = []
      const platform = yield* makeChatSdkSurface('discord', makeTypingSource(calls), {
        typingRefreshInterval: '1 second',
      })

      const fiber = yield* platform.withTyping(binding, Effect.never).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* elapseRefreshIntervals(3)
      assert.deepStrictEqual(calls, [typedThreadId, typedThreadId, typedThreadId, typedThreadId])

      yield* Fiber.interrupt(fiber)
      yield* elapseRefreshIntervals(5)
      assert.strictEqual(calls.length, 4)
    }),
  ).pipe(Effect.provide(TestClock.layer())),
)

it.effect(
  'represents an immediate startTyping failure as ChatSdkPublicationError without running the wrapped effect',
  () =>
    Effect.gen(function* () {
      let wrappedRan = false
      const platform = yield* makeChatSdkSurface('discord', {
        thread: () => ({
          post: () => Promise.resolve({}),
          startTyping: () => Promise.reject(new Error('discord down')),
        }),
      })

      const operation = yield* platform
        .withTyping(
          binding,
          Effect.sync(() => {
            wrappedRan = true
          }),
        )
        .pipe(
          Effect.catchTag('ChatSdkPublicationError', (error) => Effect.succeed(error.operation)),
        )

      assert.strictEqual(operation, 'start-typing')
      assert.strictEqual(wrappedRan, false)
    }),
)

it.effect('stops typing refreshes after a refresh failure without failing the wrapped effect', () =>
  Effect.scoped(
    Effect.gen(function* () {
      let calls = 0
      const platform = yield* makeChatSdkSurface(
        'discord',
        {
          thread: () => ({
            post: () => Promise.resolve({}),
            startTyping: () => {
              calls += 1
              return calls === 2 ? Promise.reject(new Error('discord down')) : Promise.resolve()
            },
          }),
        },
        { typingRefreshInterval: '1 second' },
      )

      const fiber = yield* platform
        .withTyping(binding, Effect.sleep('3.5 seconds'))
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      // The refresh at t=1s fails: the refresh loop logs a structured warning
      // and ends its fiber successfully, so the wrapped effect keeps running.
      yield* TestClock.adjust('1 second')
      yield* Effect.yieldNow

      const exit = yield* Effect.andThen(TestClock.adjust('3.5 seconds'), () => Fiber.await(fiber))
      assert(Exit.isSuccess(exit))
      assert.strictEqual(calls, 2)

      yield* elapseRefreshIntervals(5)
      assert.strictEqual(calls, 2)
    }),
  ).pipe(Effect.provide(TestClock.layer())),
)

it.effect('logs a structured warning when a typing refresh fails', () => {
  const logs: Array<{ level: string; message: string }> = []
  const structuredLogger = Logger.make<unknown, void>(({ logLevel, message }) => {
    logs.push({
      level: logLevel,
      message: Array.isArray(message) ? String(message[0]) : String(message),
    })
  })
  return Effect.scoped(
    Effect.gen(function* () {
      let calls = 0
      const platform = yield* makeChatSdkSurface(
        'discord',
        {
          thread: () => ({
            post: () => Promise.resolve({}),
            startTyping: () => {
              calls += 1
              return calls === 2 ? Promise.reject(new Error('discord down')) : Promise.resolve()
            },
          }),
        },
        { typingRefreshInterval: '1 second' },
      )

      const fiber = yield* platform
        .withTyping(binding, Effect.sleep('3.5 seconds'))
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      // The refresh at t=1s fails: the refresh loop logs a structured warning
      // and ends its fiber successfully, so the wrapped effect keeps running.
      yield* TestClock.adjust('1 second')
      yield* Effect.yieldNow

      const exit = yield* Effect.andThen(TestClock.adjust('3.5 seconds'), () => Fiber.await(fiber))
      assert(Exit.isSuccess(exit))
      assert.strictEqual(calls, 2)
      assert.deepStrictEqual(logs, [
        {
          level: 'Warn',
          message: 'Chat SDK typing refresh failed; stopping typing refreshes',
        },
      ])
    }).pipe(Effect.provide(TestClock.layer())),
  ).pipe(Effect.withLogger(structuredLogger), Effect.provide(Logger.layer([])))
})
