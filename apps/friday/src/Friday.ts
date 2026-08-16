import type { Thread } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import type { ThreadCoordinatorContract } from './conversation/ThreadCoordinator.ts'
import type { ThreadPersistenceError } from './conversation/ThreadPersistence.ts'
import { ThreadRuntimePool } from './conversation/ThreadRuntimePool.ts'
import type { ThreadRuntimeError } from './conversation/ThreadRuntimes.ts'

export interface FridayContract {
  readonly openThread: (
    thread: Thread,
  ) => Effect.Effect<
    ThreadCoordinatorContract<ThreadRuntimeError, ThreadRuntimeError>,
    ThreadRuntimeError | ThreadPersistenceError
  >
}

export class Friday extends Context.Service<Friday, FridayContract>()('friday/Friday') {}

export const FridayLive = Layer.effect(
  Friday,
  Effect.gen(function* () {
    const pool = yield* ThreadRuntimePool

    return Friday.of({
      openThread: pool.acquire,
    })
  }),
)
