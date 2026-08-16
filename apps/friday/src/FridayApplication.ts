import type { Thread } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'

import {
  makeThreadCoordinator,
  type ThreadCoordinatorContract,
} from './conversation/ThreadCoordinator.ts'
import { ThreadPersistence, type ThreadPersistenceError } from './conversation/ThreadPersistence.ts'
import type { ThreadRuntime } from './conversation/ThreadRuntime.ts'

export interface FridayApplicationContract<PromptError, EventError> {
  readonly openThread: (
    thread: Thread,
  ) => Effect.Effect<
    ThreadCoordinatorContract<PromptError, EventError>,
    PromptError | ThreadPersistenceError,
    Scope.Scope
  >
}

export type ThreadRuntimeFactory<PromptError, EventError> = (
  thread: Thread,
) => Effect.Effect<ThreadRuntime<PromptError, EventError>, PromptError, Scope.Scope>

export const makeFridayApplication = Effect.fn('makeFridayApplication')(function* <
  PromptError,
  EventError,
>(makeRuntime: ThreadRuntimeFactory<PromptError, EventError>) {
  const persistence = yield* ThreadPersistence

  return {
    openThread: Effect.fn('FridayApplication.openThread')(function* (thread: Thread) {
      const runtime = yield* makeRuntime(thread)
      const coordinator = yield* makeThreadCoordinator(runtime).pipe(
        Effect.provideService(ThreadPersistence, persistence),
      )
      yield* coordinator.start
      return coordinator
    }),
  } satisfies FridayApplicationContract<PromptError, EventError>
})
