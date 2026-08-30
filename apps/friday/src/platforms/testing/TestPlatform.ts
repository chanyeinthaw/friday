import {
  PlatformConnectionId,
  type ConversationBinding,
  type InputMessage,
} from '@friday/contracts/conversation'
import * as Schema from 'effect/Schema'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'

import type { PlatformAdapter, PlatformInput, PlatformPublication } from '../PlatformAdapter.ts'

export type TestPlatformEvent =
  | {
      readonly type: 'inbound-message'
      readonly inbound: PlatformInput
    }
  | {
      readonly type: 'typing-started'
      readonly binding: ConversationBinding
    }
  | {
      readonly type: 'typing-stopped'
      readonly binding: ConversationBinding
    }
  | {
      readonly type: 'message-published'
      readonly publication: PlatformPublication
    }
  | {
      readonly type:
        | 'message-acknowledged'
        | 'working-started'
        | 'working-updated'
        | 'working-finalized'
      readonly binding: ConversationBinding
      readonly text?: string
    }

export interface TestPlatformContract extends PlatformAdapter<never> {
  readonly connect: (
    onInbound: (inbound: PlatformInput) => Effect.Effect<void>,
  ) => Effect.Effect<boolean>
  readonly send: (binding: ConversationBinding, message: InputMessage) => Effect.Effect<void>
  readonly events: Effect.Effect<ReadonlyArray<TestPlatformEvent>>
  readonly clearEvents: Effect.Effect<void>
}

export class TestPlatform extends Context.Service<TestPlatform, TestPlatformContract>()(
  'friday/platforms/testing/TestPlatform',
) {}

const testConnectionId = Schema.decodeSync(PlatformConnectionId)('test')

export const TestPlatformLive = Layer.effect(
  TestPlatform,
  Effect.gen(function* () {
    type InboundHandler = (inbound: PlatformInput) => Effect.Effect<void>

    const events = yield* Ref.make<Array<TestPlatformEvent>>([])
    const inboundHandler = yield* Deferred.make<InboundHandler>()
    const record = (event: TestPlatformEvent) =>
      Ref.update(events, (current) => [...current, event])

    return TestPlatform.of({
      connectionId: testConnectionId,
      kind: 'test',
      connect: (handler) => Deferred.succeed(inboundHandler, handler),
      send: (binding, message) => {
        const inbound = { binding, message }
        return record({ type: 'inbound-message', inbound }).pipe(
          Effect.andThen(Deferred.await(inboundHandler)),
          Effect.flatMap((handler) => handler(inbound)),
        )
      },
      publish: (publication) => record({ type: 'message-published', publication }),
      acknowledge: ({ binding }) => record({ type: 'message-acknowledged', binding }),
      beginWorking: ({ binding, text }) => record({ type: 'working-started', binding, text }),
      updateWorking: ({ binding, text }) => record({ type: 'working-updated', binding, text }),
      finalizeWorking: ({ binding, text }) => record({ type: 'working-finalized', binding, text }),
      discardWorking: () => Effect.void,
      setConversationTitle: () => Effect.void,
      setAgentActivity: () => Effect.void,
      searchMessages: () => Effect.succeed({ messages: [], scannedCount: 0, truncated: false }),
      withTyping: (binding, effect) =>
        Effect.acquireUseRelease(
          record({ type: 'typing-started', binding }),
          () => effect,
          () => record({ type: 'typing-stopped', binding }),
        ),
      events: Ref.get(events),
      clearEvents: Ref.set(events, []),
    })
  }),
)
