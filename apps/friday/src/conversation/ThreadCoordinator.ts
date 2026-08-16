import type { SteeringActivity, Turn } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import {
  ThreadPersistence,
  type ThreadPersistenceContract,
  type ThreadPersistenceError,
} from './ThreadPersistence.ts'
import type { PromptRequest, ThreadRuntime, ThreadRuntimeEvent } from './ThreadRuntime.ts'

export interface ThreadCoordinatorContract<PromptError, EventError> {
  readonly prompt: (turn: Turn) => Effect.Effect<void, PromptError | ThreadPersistenceError>
  readonly steer: (
    turnId: Turn['id'],
    activity: SteeringActivity,
  ) => Effect.Effect<void, PromptError | ThreadPersistenceError>
  readonly start: Effect.Effect<void, never, Scope.Scope>
  readonly drain: Effect.Effect<void, EventError | ThreadPersistenceError>
}

const persistRuntimeEvent = (
  persistence: ThreadPersistenceContract,
  event: ThreadRuntimeEvent,
): Effect.Effect<void, ThreadPersistenceError> => {
  switch (event.type) {
    case 'turn-started':
      return persistence.startTurn(event)
    case 'activity-started':
    case 'activity-updated':
    case 'activity-completed':
      return persistence.putActivitySnapshot(event.turnId, event.activity)
    case 'turn-completed':
      return persistence.completeTurn(event)
    case 'turn-interrupted':
      return persistence.interruptTurn(event)
    case 'turn-failed':
      return persistence.failTurn(event)
    default:
      return Effect.die(new Error('Unknown ThreadRuntime event'))
  }
}

export const makeThreadCoordinator = Effect.fn('makeThreadCoordinator')(function* <
  PromptError,
  EventError,
>(runtime: ThreadRuntime<PromptError, EventError>) {
  const persistence = yield* ThreadPersistence
  yield* persistence.setThreadHarnessSession({
    threadId: runtime.threadId,
    harnessSession: runtime.harnessSession,
  })
  const drain = Stream.runForEach(runtime.events, (event) =>
    persistRuntimeEvent(persistence, event),
  )

  return {
    prompt: (turn) => {
      const request: PromptRequest = {
        turnId: turn.id,
        message: turn.input,
        mode: 'turn',
      }

      return persistence.createTurn(turn).pipe(Effect.andThen(runtime.prompt(request)))
    },
    steer: (turnId, activity) => {
      const request: PromptRequest = {
        turnId,
        message: activity.message,
      }

      return persistence
        .putActivitySnapshot(turnId, activity)
        .pipe(Effect.andThen(runtime.prompt(request)))
    },
    start: drain.pipe(Effect.forkScoped, Effect.asVoid),
    drain,
  } satisfies ThreadCoordinatorContract<PromptError, EventError>
})
