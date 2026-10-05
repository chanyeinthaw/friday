import type { Thread } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import type { ThreadCoordinatorContract } from './conversation/ThreadCoordinator.ts'
import type { ThreadPersistenceError } from './conversation/ThreadPersistence.ts'
import { PiDurable } from './harness/pi/PiDurable.ts'
import type { PiRuntimeObservation } from './harness/pi/PiDurableError.ts'
import type { PiDurableError } from './harness/pi/PiDurableError.ts'

export interface FridayContract {
  readonly openThread: (
    thread: Thread,
  ) => Effect.Effect<
    ThreadCoordinatorContract<PiDurableError, PiDurableError>,
    PiDurableError | ThreadPersistenceError
  >
  readonly observeRuntime: (threadId: Thread['id']) => Effect.Effect<PiRuntimeObservation>
}

export class Friday extends Context.Service<Friday, FridayContract>()('friday/Friday') {}

export const FridayLive = Layer.effect(
  Friday,
  Effect.gen(function* () {
    const durable = yield* PiDurable

    return Friday.of({
      openThread: durable.openThread,
      observeRuntime: durable.observe,
    })
  }),
)
