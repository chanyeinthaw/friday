import type { ExternalBinding, InputMessage } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'

import type { SurfaceContract, SurfaceInput, SurfacePublication } from '../Surface.ts'

export type TestSurfaceEvent =
  | {
      readonly type: 'inbound-message'
      readonly inbound: SurfaceInput
    }
  | {
      readonly type: 'typing-started'
      readonly binding: ExternalBinding
    }
  | {
      readonly type: 'typing-stopped'
      readonly binding: ExternalBinding
    }
  | {
      readonly type: 'message-published'
      readonly publication: SurfacePublication
    }

export interface TestSurfaceContract extends SurfaceContract<never> {
  readonly connect: (
    onInbound: (inbound: SurfaceInput) => Effect.Effect<void>,
  ) => Effect.Effect<boolean>
  readonly send: (binding: ExternalBinding, message: InputMessage) => Effect.Effect<void>
  readonly events: Effect.Effect<ReadonlyArray<TestSurfaceEvent>>
  readonly clearEvents: Effect.Effect<void>
}

export class TestSurface extends Context.Service<TestSurface, TestSurfaceContract>()(
  'friday/surfaces/testing/TestSurface',
) {}

export const TestSurfaceLive = Layer.effect(
  TestSurface,
  Effect.gen(function* () {
    type InboundHandler = (inbound: SurfaceInput) => Effect.Effect<void>

    const events = yield* Ref.make<Array<TestSurfaceEvent>>([])
    const inboundHandler = yield* Deferred.make<InboundHandler>()
    const record = (event: TestSurfaceEvent) => Ref.update(events, (current) => [...current, event])

    return TestSurface.of({
      kind: 'discord',
      connect: (handler) => Deferred.succeed(inboundHandler, handler),
      send: (binding, message) => {
        const inbound = { binding, message }
        return record({ type: 'inbound-message', inbound }).pipe(
          Effect.andThen(Deferred.await(inboundHandler)),
          Effect.flatMap((handler) => handler(inbound)),
        )
      },
      publish: (publication) => record({ type: 'message-published', publication }),
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
