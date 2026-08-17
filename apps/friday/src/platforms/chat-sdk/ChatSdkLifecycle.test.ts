import { assert, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import { TestClock } from 'effect/testing'

import { ChatSdkCallbackError } from './Errors.ts'
import { startChatSdkLifecycle, type ChatSdkLifecycleSource } from './ChatSdkLifecycle.ts'
import { makeChatSdkPlatform, type ChatSdkPublicationSource } from './ChatSdkPlatform.ts'
import type {
  ChatSdkMessageProjectionSource,
  ChatSdkThreadProjectionSource,
} from './MessageProjection.ts'

const isChatSdkCallbackError = Schema.is(ChatSdkCallbackError)

it.effect('keeps effectful authorization failures inside the callback error channel', () =>
  Effect.gen(function* () {
    const handlers: Array<
      (
        thread: ChatSdkThreadProjectionSource,
        message: ChatSdkMessageProjectionSource,
      ) => Promise<void>
    > = []
    const chat: ChatSdkLifecycleSource = {
      initialize: async () => undefined,
      shutdown: async () => undefined,
      thread: () => ({ post: () => Promise.resolve({}) }),
      onNewMention: (handler) => handlers.push(handler),
      onDirectMessage: (handler) => handlers.push(handler),
      onSubscribedMessage: (handler) => handlers.push(handler),
    }

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* startChatSdkLifecycle({
          chat,
          shouldHandleMessage: () =>
            Effect.fail(
              new ChatSdkCallbackError({
                operation: 'inbound-message',
                cause: 'authorization failed',
              }),
            ),
          onInboundMessage: () => Effect.die('inbound should not run'),
        })
        const handler = handlers[0]
        assert(handler !== undefined)
        const exit = yield* Effect.promise(() =>
          handler(
            {
              adapter: { name: 'discord' },
              channelId: 'channel-1',
              id: 'thread-1',
            },
            {
              id: 'message-1',
              text: 'hello',
              author: {
                userId: 'user-1',
                userName: 'user',
                fullName: 'User',
                isBot: false,
                isMe: false,
              },
            },
          ).then(
            () => Exit.succeed(undefined),
            (cause) => Exit.fail(cause),
          ),
        )
        assert(Exit.isFailure(exit))
        assert(isChatSdkCallbackError(Cause.squash(exit.cause)))
      }),
    )
  }),
)

it.effect('owns Chat SDK initialization, callbacks, and shutdown in scope', () =>
  Effect.gen(function* () {
    const events: Array<string> = []
    const handlers: Array<
      (
        thread: ChatSdkThreadProjectionSource,
        message: ChatSdkMessageProjectionSource,
      ) => Promise<void>
    > = []
    const chat: ChatSdkLifecycleSource = {
      initialize: async () => {
        events.push('initialize')
      },
      shutdown: async () => {
        events.push('shutdown')
      },
      thread: () => ({ post: () => Promise.resolve({}) }),
      onNewMention: (handler) => handlers.push(handler),
      onDirectMessage: (handler) => handlers.push(handler),
      onSubscribedMessage: (handler) => handlers.push(handler),
    }

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* startChatSdkLifecycle({
          chat,
          onInboundMessage: (inbound) =>
            Effect.sync(() => {
              events.push(`inbound:${inbound.message.content.text}`)
            }),
        })
        assert.strictEqual(handlers.length, 3)
        yield* Effect.promise(
          () =>
            handlers[0]?.(
              {
                adapter: { name: 'discord' },
                channelId: 'channel-1',
                id: 'thread-1',
              },
              {
                id: 'message-1',
                text: 'hello',
                author: {
                  userId: 'user-1',
                  userName: 'user',
                  fullName: 'User',
                  isBot: false,
                  isMe: false,
                },
              },
            ) ?? Promise.resolve(),
        )
        assert.deepStrictEqual(events, ['initialize', 'inbound:hello'])
      }),
    )

    assert.deepStrictEqual(events, ['initialize', 'inbound:hello', 'shutdown'])
  }),
)

// Lets `count` typing refresh intervals elapse on the test clock. Each
// interval crosses a real promise microtask: advancing the clock wakes the
// refresh fiber at its sleep deadline, but its next sleep is only registered
// after the microtask flush, so every elapsed interval is followed by a
// `yieldNow` before the next interval.
const elapseRefreshIntervals = (count: number): Effect.Effect<void> =>
  Effect.forEach(Array.from({ length: count }), () =>
    TestClock.adjust('1 second').pipe(Effect.andThen(Effect.yieldNow)),
  ).pipe(Effect.asVoid)

it.effect(
  'interrupts active inbound workers and their typing refreshes when the lifecycle scope closes',
  () =>
    Effect.gen(function* () {
      const events: Array<string> = []
      const typingCalls: Array<string> = []
      const handlers: Array<
        (
          thread: ChatSdkThreadProjectionSource,
          message: ChatSdkMessageProjectionSource,
        ) => Promise<void>
      > = []
      // The fake Chat SDK doubles as both the lifecycle source and the
      // publication source (startTyping) so the ingestion path under test can
      // run a real typing refresh loop.
      const chat: ChatSdkLifecycleSource & ChatSdkPublicationSource = {
        initialize: async () => {
          events.push('initialize')
        },
        shutdown: async () => {
          events.push('shutdown')
        },
        thread: (threadId) => ({
          post: () => Promise.resolve({}),
          startTyping: () => {
            typingCalls.push(threadId)
            return Promise.resolve()
          },
        }),
        onNewMention: (handler) => handlers.push(handler),
        onDirectMessage: (handler) => handlers.push(handler),
        onSubscribedMessage: (handler) => handlers.push(handler),
      }

      // The callback Promise is created inside the scope but settled after
      // it closes, so its settlement is observed from a forked fiber: the
      // rejection handler is attached before scope close can reject the
      // Promise, and the resulting Exit is available to the test body.
      let callbackPromise: Promise<void> = Promise.resolve()
      const outcomeFiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const platform = yield* makeChatSdkPlatform('discord', chat, {
            typingRefreshInterval: '1 second',
          })
          yield* startChatSdkLifecycle({
            chat,
            // The inbound worker never completes: it keeps a finalizer marker
            // installed while a typing refresh loop runs underneath it.
            onInboundMessage: (inbound) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  events.push('inbound:start')
                }),
                () =>
                  Effect.sync(() => {
                    events.push('inbound:finalizer')
                  }),
              ).pipe(Effect.andThen(platform.withTyping(inbound.binding, Effect.never))),
          })
          assert.strictEqual(handlers.length, 3)

          callbackPromise =
            handlers[0]?.(
              {
                adapter: { name: 'discord' },
                channelId: 'channel-1',
                id: 'thread-1',
              },
              {
                id: 'message-1',
                text: 'hello',
                author: {
                  userId: 'user-1',
                  userName: 'user',
                  fullName: 'User',
                  isBot: false,
                  isMe: false,
                },
              },
            ) ?? Promise.resolve()
          return yield* Effect.tryPromise(() => callbackPromise).pipe(Effect.exit, Effect.forkChild)
        }).pipe(
          Effect.andThen((callbackOutcomeFiber) =>
            Effect.yieldNow.pipe(
              Effect.andThen(elapseRefreshIntervals(2)),
              Effect.andThen(
                Effect.sync(() => {
                  // Two refresh intervals elapse while ingestion is in flight
                  // (the immediate typing indicator plus two refreshes).
                  assert.deepStrictEqual(typingCalls, ['thread-1', 'thread-1', 'thread-1'])
                  return callbackOutcomeFiber
                }),
              ),
            ),
          ),
        ),
      )
      // The lifecycle scope closes here: the inbound worker is interrupted,
      // which interrupts its typing refresh fiber.

      // The worker finalizer ran and shutdown completed: closure interrupted
      // the in-flight ingestion rather than letting it leak.
      assert.deepStrictEqual(events, [
        'initialize',
        'inbound:start',
        'inbound:finalizer',
        'shutdown',
      ])

      // The callback Promise settles (rejected as interrupted) instead of
      // hanging, so the Chat SDK is not left with a dangling await.
      const outcome = yield* Fiber.await(outcomeFiber)
      assert(Exit.isSuccess(outcome))
      assert(Exit.isFailure(outcome.value))

      // No typing refresh fires after scope closure.
      yield* elapseRefreshIntervals(5)
      assert.strictEqual(typingCalls.length, 3)
    }).pipe(Effect.provide(TestClock.layer())),
)
