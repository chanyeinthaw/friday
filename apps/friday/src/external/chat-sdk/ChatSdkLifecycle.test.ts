import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { makeChatSdkLifecycle, type ChatSdkLifecycleSource } from './ChatSdkLifecycle.ts'
import type {
  ChatSdkMessageProjectionSource,
  ChatSdkThreadProjectionSource,
} from './MessageProjection.ts'

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
      onNewMention: (handler) => handlers.push(handler),
      onDirectMessage: (handler) => handlers.push(handler),
      onSubscribedMessage: (handler) => handlers.push(handler),
    }

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* makeChatSdkLifecycle({
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
              { id: 'message-1', text: 'hello' },
            ) ?? Promise.resolve(),
        )
        assert.deepStrictEqual(events, ['initialize', 'inbound:hello'])
      }),
    )

    assert.deepStrictEqual(events, ['initialize', 'inbound:hello', 'shutdown'])
  }),
)
