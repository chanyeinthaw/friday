import type { Thread } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type * as Scope from 'effect/Scope'

import {
  makeThreadCoordinator,
  type ThreadCoordinatorContract,
} from './conversation/ThreadCoordinator.ts'
import { ThreadPersistence, type ThreadPersistenceError } from './conversation/ThreadPersistence.ts'
import { ThreadRuntimeError, ThreadRuntimes } from './conversation/ThreadRuntimes.ts'

export interface FridayContract {
  readonly openThread: (
    thread: Thread,
  ) => Effect.Effect<
    ThreadCoordinatorContract<ThreadRuntimeError, ThreadRuntimeError>,
    ThreadRuntimeError | ThreadPersistenceError,
    Scope.Scope
  >
}

export class Friday extends Context.Service<Friday, FridayContract>()('friday/Friday') {}

export const FridayLive = Layer.effect(
  Friday,
  Effect.gen(function* () {
    const persistence = yield* ThreadPersistence
    const runtimes = yield* ThreadRuntimes

    return Friday.of({
      openThread: Effect.fn('Friday.openThread')(function* (thread: Thread) {
        const runtime = yield* runtimes.open(thread)
        const coordinator = yield* makeThreadCoordinator(runtime).pipe(
          Effect.provideService(ThreadPersistence, persistence),
        )
        yield* coordinator.start
        return coordinator
      }),
    })
  }),
)
