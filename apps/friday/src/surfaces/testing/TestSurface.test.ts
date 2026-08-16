import { assert, it } from '@effect/vitest'
import { SurfaceBinding, InputMessage } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'

import { TestSurface, TestSurfaceLive } from './TestSurface.ts'

const binding = Schema.decodeSync(SurfaceBinding)({
  surface: 'discord',
  channelId: 'discord:guild:channel',
  sourceMessageId: 'message-1',
  conversationId: 'discord:guild:channel:thread-1',
})
const message = Schema.decodeSync(InputMessage)({
  source: 'user',
  content: { text: 'Hello Friday', images: [] },
  surfaceMessageId: 'message-1',
})

it.effect('drives normalized inbound messages and records final publication', () =>
  Effect.gen(function* () {
    const chat = yield* TestSurface
    yield* chat.connect((inbound) =>
      chat.publish({ binding: inbound.binding, text: `Reply: ${inbound.message.content.text}` }),
    )

    yield* chat.send(binding, message)
    const events = yield* chat.events

    assert.deepStrictEqual(
      events.map(({ type }) => type),
      ['inbound-message', 'message-published'],
    )
    const published = events.find((event) => event.type === 'message-published')
    assert.strictEqual(
      published?.type === 'message-published' ? published.publication.text : null,
      'Reply: Hello Friday',
    )
  }).pipe(Effect.provide(TestSurfaceLive)),
)

it.effect('always records typing stopped after success, failure, and interruption', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const chat = yield* TestSurface

      yield* chat.withTyping(binding, Effect.void)
      const failed = yield* chat.withTyping(binding, Effect.fail('boom')).pipe(Effect.exit)
      assert(Exit.isFailure(failed))

      const interruptedFiber = yield* chat.withTyping(binding, Effect.never).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(interruptedFiber)

      const events = yield* chat.events
      assert.deepStrictEqual(
        events.map(({ type }) => type),
        [
          'typing-started',
          'typing-stopped',
          'typing-started',
          'typing-stopped',
          'typing-started',
          'typing-stopped',
        ],
      )
    }).pipe(Effect.provide(TestSurfaceLive)),
  ),
)
